<?php
/*
 * Navigation Dropdown Menus
 * Dynamic provider for Docker, VMs, and optional Unassigned Devices inventory.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');

function jnd_json($payload, int $status = 200): never {
    http_response_code($status);
    echo json_encode(
        $payload,
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE |
        JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
    );
    exit;
}

function jnd_icon_descriptor($value): ?array {
    $value = trim((string)$value);
    if ($value === '') return null;

    if (preg_match('/\.png(?:\?.*)?$/i', $value) && str_starts_with($value, '/')) {
        if (preg_match('/[\x00-\x1F\x7F]/', $value)) return null;
        return ['kind' => 'img', 'src' => $value];
    }

    if (str_starts_with($value, 'icon-') && preg_match('/^icon-[A-Za-z0-9_-]+$/', $value)) {
        return ['kind' => 'class', 'className' => $value];
    }

    $fa = $value;
    if (str_starts_with($fa, 'fa-')) {
        if (!preg_match('/^fa-[A-Za-z0-9_-]+$/', $fa)) return null;
        return ['kind' => 'class', 'className' => 'fa ' . $fa];
    }

    if (preg_match('/^[A-Za-z0-9_-]+$/', $fa)) {
        return ['kind' => 'class', 'className' => 'fa fa-' . $fa];
    }

    return null;
}

function jnd_settings(): array {
    static $cfg = null;
    if ($cfg !== null) return $cfg;

    $file = '/boot/config/plugins/nav.dropdown.menus/nav.dropdown.menus.cfg';
    $parsed = is_readable($file) ? @parse_ini_file($file, false, INI_SCANNER_RAW) : [];
    $cfg = is_array($parsed) ? $parsed : [];
    return $cfg;
}

function jnd_setting_bool(string $key, bool $default = false): bool {
    $cfg = jnd_settings();
    if (!array_key_exists($key, $cfg)) return $default;
    return in_array(strtolower(trim((string)$cfg[$key])), ['1', 'yes', 'true', 'on'], true);
}

function jnd_decode_mount_field(string $value): string {
    return str_replace(['\\040', '\\011', '\\134'], [' ', "\t", '\\'], $value);
}

function jnd_proc_mounts(): array {
    $rows = [];
    if (!is_readable('/proc/mounts')) return $rows;

    foreach (@file('/proc/mounts', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        $parts = preg_split('/\s+/', trim((string)$line));
        if (count($parts) < 3) continue;
        $rows[] = [
            'source' => jnd_decode_mount_field((string)$parts[0]),
            'mountpoint' => jnd_decode_mount_field((string)$parts[1]),
            'fstype' => (string)$parts[2],
        ];
    }
    return $rows;
}

function jnd_ud_safe_component(string $value): string {
    $value = html_entity_decode($value, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $value = preg_replace('/[\x00-\x1F\x7F]+/u', '', $value) ?? '';
    $value = str_replace(["'", '"', '?', '#', '&', '!', '<', '>', '[', ']', '{', '}', '|', '+', '@', ' '], '_', $value);
    return trim($value, '/');
}

function jnd_ud_remote_items(): array {
    $pluginRoot = '/usr/local/emhttp/plugins/unassigned.devices';
    if (!is_dir($pluginRoot)) return [];

    $items = [];
    $seen = [];

    foreach (jnd_proc_mounts() as $mount) {
        $mountpoint = (string)($mount['mountpoint'] ?? '');
        if (!str_starts_with($mountpoint, '/mnt/remotes/')) continue;

        $label = trim((string)basename($mountpoint));
        if ($label === '' || $label === '.' || $label === '/') continue;

        $key = strtolower($mountpoint);
        if (isset($seen[$key])) continue;
        $seen[$key] = true;

        $items[] = [
            'type' => 'item',
            'label' => $label,
            'href' => '/Main/Browse?dir=' . rawurlencode($mountpoint),
            'icon' => ['kind' => 'class', 'className' => 'fa fa-folder-o'],
            'indent' => 1,
        ];
    }

    usort($items, static function($a, $b) {
        return strnatcasecmp((string)($a['label'] ?? ''), (string)($b['label'] ?? ''));
    });

    return $items;
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    jnd_json(['ok' => false, 'error' => 'Method not allowed'], 405);
}

$provider = (string)($_GET['provider'] ?? '');
$docroot = $_SERVER['DOCUMENT_ROOT'] ?: '/usr/local/emhttp';

try {
    switch ($provider) {
        case 'docker': {
            require_once "$docroot/webGui/include/Helpers.php";
            require_once "$docroot/plugins/dynamix.docker.manager/include/DockerClient.php";

            $DockerClient = new DockerClient();
            $DockerTemplates = new DockerTemplates();
            $containers = $DockerClient->getDockerContainers() ?: [];
            $allInfo = $DockerTemplates->getAllInfo() ?: [];

            $showStatus = jnd_setting_bool('DOCKER_STATUS_INDICATORS', true);
            $quickActions = $showStatus && jnd_setting_bool('DOCKER_QUICK_ACTIONS', false);

            $userPrefs = $dockerManPaths['user-prefs'] ?? '';
            if ($userPrefs && is_file($userPrefs)) {
                $prefs = (array)@parse_ini_file($userPrefs);
                $sort = [];
                foreach ($containers as $ct) $sort[] = array_search($ct['Name'], $prefs);
                if (!empty($containers)) array_multisort($sort, SORT_NUMERIC, $containers);
            }

            $items = [];
            foreach ($containers as $ct) {
                $name = (string)($ct['Name'] ?? '');
                if ($name === '') continue;

                $info = $allInfo[$name] ?? [];
                $running = !empty($info['running']);
                $paused = !empty($info['paused']);
                $state = $running ? ($paused ? 'paused' : 'started') : 'stopped';

                $template = (string)($info['template'] ?? '');
                $compose = (string)($ct['ComposeProject'] ?? '');
                $href = null;

                if ($template !== '' && $compose === '') {
                    $href = '/Docker/UpdateContainer?xmlTemplate=' . rawurlencode('edit:' . $template);
                }

                $webui = trim(html_entity_decode(
                    (string)($info['url'] ?? ($ct['Url'] ?? '')),
                    ENT_QUOTES | ENT_HTML5,
                    'UTF-8'
                ));
                if ($webui === '#') $webui = '';

                $iconValue = (string)($info['icon'] ?? '');
                $icon = jnd_icon_descriptor($iconValue);
                if ($icon === null) {
                    $icon = ['kind' => 'img', 'src' => '/plugins/dynamix.docker.manager/images/question.png'];
                }

                $control = null;
                $containerId = trim((string)($ct['Id'] ?? ''));
                if ($quickActions && $containerId !== '' && $state !== 'paused') {
                    $control = [
                        'kind' => 'docker',
                        'id' => $containerId,
                        'action' => $state === 'started' ? 'stop' : 'start',
                    ];
                }

                $items[] = [
                    'type' => 'item',
                    'label' => $name,
                    'href' => $href,
                    'state' => $state,
                    'statusKind' => 'docker',
                    'icon' => $icon,
                    'control' => $control,
                    'log' => [
                        'kind' => 'docker',
                        'name' => $name,
                        'more' => '.log',
                    ],
                    'webui' => $webui !== '' ? $webui : null,
                ];
            }

            jnd_json(['ok' => true, 'items' => $items]);
        }

        case 'vms': {
            require_once "$docroot/webGui/include/Helpers.php";
            require_once "$docroot/plugins/dynamix.vm.manager/include/libvirt_helpers.php";

            $domains = [];
            if (isset($lv)) {
                $domains = $lv->get_domains() ?: [];
            }

            $showStatus = jnd_setting_bool('VM_STATUS_INDICATORS', true);
            $quickActions = $showStatus && jnd_setting_bool('VM_QUICK_ACTIONS', false);

            $userPrefs = '/boot/config/plugins/dynamix.vm.manager/userprefs.cfg';
            if (is_file($userPrefs)) {
                $prefs = (array)@parse_ini_file($userPrefs);
                $sort = [];
                foreach ($domains as $vm) $sort[] = array_search($vm, $prefs);
                if (!empty($domains)) array_multisort($sort, SORT_NUMERIC, $domains);
            } else {
                natcasesort($domains);
            }

            $items = [];
            foreach ($domains as $vm) {
                $res = $lv->get_domain_by_name($vm);
                if (!$res) continue;

                $uuid = (string)$lv->domain_get_uuid($res);
                if ($uuid === '') continue;

                $dom = $lv->domain_get_info($res);
                $translated = strtolower((string)$lv->domain_state_translate($dom['state'] ?? ''));
                $state = match ($translated) {
                    'running' => 'started',
                    'paused', 'pmsuspended' => 'paused',
                    default => 'stopped',
                };

                $iconValue = (string)$lv->domain_get_icon_url($res);
                $icon = jnd_icon_descriptor($iconValue);

                // Match Unraid's native VM log discovery.
                $vmLog = is_file("/var/log/libvirt/qemu/$vm.log")
                    ? "libvirt/qemu/$vm.log"
                    : '';

                // Match Unraid's native web-console availability for a running VNC VM.
                $vncConsole = '';
                if ($state === 'started') {
                    $vmrcPort = (int)$lv->domain_get_vnc_port($res);
                    $vmrcProtocol = strtolower((string)$lv->domain_get_vmrc_protocol($res));
                    $consoleMode = strtolower((string)($domain_cfg['CONSOLE'] ?? 'web'));

                    if ($vmrcPort > 0 && $vmrcProtocol === 'vnc' && in_array($consoleMode, ['web', 'both'], true)) {
                        $wsPort = (int)$lv->domain_get_ws_port($res);
                        $httpHost = trim((string)($_SERVER['HTTP_HOST'] ?? ''));

                        if ($wsPort > 0 && $httpHost !== '') {
                            $vncConsole = autov('/plugins/dynamix.vm.manager/vnc.html', true)
                                . '&resize=scale'
                                . '&autoconnect=true'
                                . '&host=' . rawurlencode($httpHost)
                                . '&port='
                                . '&path=/wsproxy/' . $wsPort . '/';
                        }
                    }
                }

                $control = null;
                if ($quickActions && $state !== 'paused') {
                    $control = [
                        'kind' => 'vm',
                        'id' => $uuid,
                        'action' => $state === 'started' ? 'domain-stop' : 'domain-start',
                    ];
                }

                $items[] = [
                    'type' => 'item',
                    'label' => (string)$vm,
                    'href' => '/VMs/UpdateVM?uuid=' . rawurlencode($uuid),
                    'state' => $state,
                    'statusKind' => 'vm',
                    'icon' => $icon,
                    'control' => $control,
                    'log' => $vmLog !== '' ? [
                        'kind' => 'vm',
                        'name' => (string)$vm,
                        'more' => $vmLog,
                    ] : null,
                    'vncConsole' => $vncConsole !== '' ? $vncConsole : null,
                ];
            }

            jnd_json(['ok' => true, 'items' => array_values($items)]);
        }

        case 'ud_remotes': {
            jnd_json(['ok' => true, 'items' => jnd_ud_remote_items()]);
        }

        default:
            jnd_json(['ok' => false, 'error' => 'Unknown provider'], 400);
    }
} catch (Throwable $e) {
    jnd_json([
        'ok' => false,
        'error' => 'Provider failed',
        'provider' => $provider,
    ], 500);
}
