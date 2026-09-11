<?php
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');

function jnd_settings_json(array $payload, int $status = 200): never {
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    jnd_settings_json(['ok' => false, 'error' => 'Method not allowed'], 405);
}

function jnd_post_bool(string $key): ?string {
    if (!array_key_exists($key, $_POST)) return null;
    $value = strtolower(trim((string)$_POST[$key]));
    if (in_array($value, ['1', 'yes', 'true', 'on'], true)) return '1';
    if (in_array($value, ['0', 'no', 'false', 'off'], true)) return '0';
    return null;
}

function jnd_post_choice(string $key, array $allowed): ?string {
    if (!array_key_exists($key, $_POST)) return null;
    $value = trim((string)$_POST[$key]);
    return in_array($value, $allowed, true) ? $value : null;
}

$boolFields = [
    'dropdown_main' => 'DROPDOWN_MAIN',
    'dropdown_shares' => 'DROPDOWN_SHARES',
    'dropdown_users' => 'DROPDOWN_USERS',
    'dropdown_settings' => 'DROPDOWN_SETTINGS',
    'dropdown_plugins' => 'DROPDOWN_PLUGINS',
    'dropdown_docker' => 'DROPDOWN_DOCKER',
    'dropdown_vms' => 'DROPDOWN_VMS',
    'dropdown_tools' => 'DROPDOWN_TOOLS',
    'show_unassigned_devices' => 'SHOW_UNASSIGNED_DEVICES',
    'docker_status_indicators' => 'DOCKER_STATUS_INDICATORS',
    'docker_quick_actions' => 'DOCKER_QUICK_ACTIONS',
    'docker_confirm_stop' => 'DOCKER_CONFIRM_STOP',
    'docker_log_buttons' => 'DOCKER_LOG_BUTTONS',
    'docker_webui_buttons' => 'DOCKER_WEBUI_BUTTONS',
    'vm_status_indicators' => 'VM_STATUS_INDICATORS',
    'vm_quick_actions' => 'VM_QUICK_ACTIONS',
    'vm_confirm_stop' => 'VM_CONFIRM_STOP',
    'vm_log_buttons' => 'VM_LOG_BUTTONS',
    'vm_vnc_console_buttons' => 'VM_VNC_CONSOLE_BUTTONS',
    'webui_new_tab' => 'WEBUI_NEW_TAB',
];

$values = [];
foreach ($boolFields as $postKey => $configKey) {
    $value = jnd_post_bool($postKey);
    if ($value === null) {
        jnd_settings_json(['ok' => false, 'error' => 'Invalid setting value'], 400);
    }
    $values[$configKey] = $value;
}

$hoverOpenMs = jnd_post_choice('hover_open_ms', ['75', '100', '150', '200']);
$sortMode = jnd_post_choice('sort_mode', ['unraid', 'alphabetical']);
if ($hoverOpenMs === null || $sortMode === null) {
    jnd_settings_json(['ok' => false, 'error' => 'Invalid setting value'], 400);
}

$values['HOVER_OPEN_MS'] = $hoverOpenMs;
$values['SORT_MODE'] = $sortMode;

/*
 * A hidden status indicator cannot safely expose an invisible quick-action
 * control. Enforce that dependency server-side as well as in the Settings UI.
 */
if ($values['DOCKER_STATUS_INDICATORS'] !== '1') $values['DOCKER_QUICK_ACTIONS'] = '0';
if ($values['VM_STATUS_INDICATORS'] !== '1') $values['VM_QUICK_ACTIONS'] = '0';

$order = [
    'DROPDOWN_MAIN',
    'DROPDOWN_SHARES',
    'DROPDOWN_USERS',
    'DROPDOWN_SETTINGS',
    'DROPDOWN_PLUGINS',
    'DROPDOWN_DOCKER',
    'DROPDOWN_VMS',
    'DROPDOWN_TOOLS',
    'SHOW_UNASSIGNED_DEVICES',
    'HOVER_OPEN_MS',
    'SORT_MODE',
    'DOCKER_STATUS_INDICATORS',
    'DOCKER_QUICK_ACTIONS',
    'DOCKER_CONFIRM_STOP',
    'DOCKER_LOG_BUTTONS',
    'DOCKER_WEBUI_BUTTONS',
    'WEBUI_NEW_TAB',
    'VM_STATUS_INDICATORS',
    'VM_QUICK_ACTIONS',
    'VM_CONFIRM_STOP',
    'VM_LOG_BUTTONS',
    'VM_VNC_CONSOLE_BUTTONS',
];

$lines = [];
foreach ($order as $key) {
    $lines[] = $key . '="' . $values[$key] . '"';
}
$content = implode("\n", $lines) . "\n";

$dir = '/boot/config/plugins/nav.dropdown.menus';
$file = $dir . '/nav.dropdown.menus.cfg';
if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir)) {
    jnd_settings_json(['ok' => false, 'error' => 'Unable to create configuration directory'], 500);
}

$tmp = $file . '.tmp.' . getmypid();
if (@file_put_contents($tmp, $content, LOCK_EX) === false) {
    jnd_settings_json(['ok' => false, 'error' => 'Unable to write configuration'], 500);
}
@chmod($tmp, 0644);
if (!@rename($tmp, $file)) {
    @unlink($tmp);
    jnd_settings_json(['ok' => false, 'error' => 'Unable to commit configuration'], 500);
}

jnd_settings_json([
    'ok' => true,
    'settings' => $values,
]);
