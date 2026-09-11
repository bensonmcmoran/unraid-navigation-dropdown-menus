#!/usr/bin/env python3
from pathlib import Path
import argparse, base64, re, shutil, subprocess, sys, tempfile
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parents[1]
VERSION="1.0.0"
MINVER="7.3.2"
PLUGIN_URL="https://raw.githubusercontent.com/bensonmcmoran/unraid-navigation-dropdown-menus/main/nav.dropdown.menus.plg"
SUPPORT_URL="https://github.com/bensonmcmoran/unraid-navigation-dropdown-menus/issues"
PROJECT_URL="https://github.com/bensonmcmoran/unraid-navigation-dropdown-menus"
class VError(RuntimeError): pass
def need(v,m):
    if not v: raise VError(m)
def run(cmd):
    r=subprocess.run(cmd,text=True,capture_output=True)
    if r.returncode: raise VError("command failed: "+" ".join(cmd)+"\n"+r.stdout+r.stderr)
    return r
def payload(text,name):
    m=re.search(r'<FILE Name="&runtime;/'+re.escape(name)+r'"[^>]*>\s*<INLINE><!\[CDATA\[(.*?)\]\]></INLINE>\s*</FILE>',text,re.S)
    need(m is not None,"missing embedded "+name);return m.group(1)
def metadata(text):
    need(f'<!ENTITY version "{VERSION}">' in text,"version mismatch")
    need(f'<!ENTITY pluginURL "{PLUGIN_URL}">' in text,"PluginURL mismatch")
    need(f'<!ENTITY supportURL "{SUPPORT_URL}">' in text,"supportURL mismatch")
    need('pluginURL="&pluginURL;"' in text,"PluginURL not published")
    need('support="&supportURL;"' in text,"support URL not published")
    need(f'min="{MINVER}"' in text,"MinVer mismatch")
    low=text.lower()
    for marker in ["jarvis.nav.dropdown","pre-public test build","prepublic-test","1.0.8","1.0.9","1.0.10","1.0.11","1.0.12"]:
        need(marker not in low,"private marker remains: "+marker)
def runtime(js,page,sp,provider,settings,css):
    need("new Set([75, 100, 150, 200])" in js,"hover choices missing")
    need("? configuredHoverOpenMs : 100;" in js,"hover default missing")
    need("SORTABLE_TARGETS" in js and "LABEL_COLLATOR.compare" in js,"sort missing")
    need("BOOT?.dropdowns?.[target] !== false" in js,"dropdown toggles missing")
    need("loadDynamicProvider('ud_remotes')" in js and "ensureMainUDFresh();" in js,"UD path missing")
    need("get_ud_content" not in js and "/plugins/unassigned.devices/include/UnassignedDevices.php" not in js,"heavy UD request remains")
    need("fa fa-navicon" in js and "fa fa-globe" in js and "fa fa-desktop" in js,"inline control icon missing")
    need("window.location.assign(href);" in js and "window.open(href, '_blank', 'noopener,noreferrer');" in js,"WebUI tab behavior missing")
    need("cleanText(item?.state).toLowerCase() !== 'started'" in js,"WebUI running gate missing")
    need("createInlinePlaceholder('webui')" in js and "createInlinePlaceholder('vnc')" in js,"alignment placeholder missing")
    for key in ["DROPDOWN_MAIN","DROPDOWN_SHARES","DROPDOWN_USERS","DROPDOWN_SETTINGS","DROPDOWN_PLUGINS","DROPDOWN_DOCKER","DROPDOWN_VMS","DROPDOWN_TOOLS"]:
        need(f"jnd_cfg_bool('{key}', true)" in page,key+" default missing")
    for key in ["SHOW_UNASSIGNED_DEVICES","DOCKER_STATUS_INDICATORS","VM_STATUS_INDICATORS","DOCKER_CONFIRM_STOP","VM_CONFIRM_STOP","DOCKER_LOG_BUTTONS","VM_LOG_BUTTONS","DOCKER_WEBUI_BUTTONS","WEBUI_NEW_TAB","VM_VNC_CONSOLE_BUTTONS"]:
        need(f"jnd_cfg_bool('{key}', true)" in page,key+" default missing")
    need("jnd_cfg_bool('DOCKER_QUICK_ACTIONS', false)" in page and "jnd_cfg_bool('VM_QUICK_ACTIONS', false)" in page,"quick-action defaults missing")
    need("setDisabled('jnd-docker-quick', !dockerEnabled || !dockerStatusEnabled);" in sp,"Docker dependency missing")
    need("setDisabled('jnd-vm-quick', !vmEnabled || !vmStatusEnabled);" in sp,"VM dependency missing")
    need("setDisabled('jnd-docker-confirm', !dockerEnabled || !dockerStatusEnabled || !dockerQuickEnabled);" in sp,"Docker confirm dependency missing")
    need("setDisabled('jnd-vm-confirm', !vmEnabled || !vmStatusEnabled || !vmQuickEnabled);" in sp,"VM confirm dependency missing")
    need("setDisabled('jnd-vm-vnc', !vmEnabled);" in sp,"VM VNC dependency missing")
    need("'vm_vnc_console_buttons' => 'VM_VNC_CONSOLE_BUTTONS'" in settings,"VM VNC persistence missing")
    need("'docker_log_buttons' => 'DOCKER_LOG_BUTTONS'" in settings and "'vm_log_buttons' => 'VM_LOG_BUTTONS'" in settings,"log persistence missing")
    need("max-width: 900px" not in sp and "max-width: 850px" not in sp and "max-width: 820px" not in sp,"obsolete max-width remains")
    need("overflow-wrap: anywhere;" in sp,"help wrapping missing")
    need(".jnd-settings-section" in sp and "background: var(--mild-background-color);" in sp and "border-left: 3px solid var(--brand-orange);" in sp,"settings panels missing")
    need(".jnd-inline-placeholder" in css and ".jnd-user-avatar" in css,"CSS styling missing")
    need("fa fa-folder-o" in page and "fa fa-folder-o" in provider and "jnd_user_image_descriptor" in page,"menu icon support missing")
def validate():
    plg=ROOT/"nav.dropdown.menus.plg";text=plg.read_text(encoding="utf-8")
    for p in [plg,ROOT/"ca_profile.xml",ROOT/"plugins/nav.dropdown.menus.xml"]: ET.parse(p)
    metadata(text)
    w=ET.parse(ROOT/"plugins/nav.dropdown.menus.xml").getroot()
    need(w.findtext("PluginURL")==PLUGIN_URL,"wrapper PluginURL")
    need(w.findtext("Support")==SUPPORT_URL,"wrapper Support")
    need(w.findtext("Project")==PROJECT_URL,"wrapper Project")
    need(w.findtext("MinVer")==MINVER,"wrapper MinVer")
    need(w.findtext("License")=="MIT","wrapper License")
    p=ET.parse(ROOT/"ca_profile.xml").getroot()
    need(p.findtext("Forum")==SUPPORT_URL,"profile Support")
    need(p.findtext("WebPage")==PROJECT_URL,"profile WebPage")
    m=re.search(r'<FILE Name="/tmp/nav\.dropdown\.menus\.icon\.b64"[^>]*>\s*<INLINE><!\[CDATA\[(.*?)\]\]></INLINE>',text,re.S)
    need(m is not None,"embedded icon missing")
    need(base64.b64decode("".join(m.group(1).split()))==(ROOT/"nav.dropdown.menus.png").read_bytes(),"icon mismatch")
    names=["NavDropdownMenus.page","NavDropdownMenusSettings.page","provider.php","settings.php","nav-dropdowns.css","nav-dropdowns.js"]
    for n in names:
        s=ROOT/"src"/n;need(payload(text,n)==s.read_text(encoding="utf-8"),"source mismatch "+n)
    runtime((ROOT/"src/nav-dropdowns.js").read_text(),(ROOT/"src/NavDropdownMenus.page").read_text(),
            (ROOT/"src/NavDropdownMenusSettings.page").read_text(),(ROOT/"src/provider.php").read_text(),
            (ROOT/"src/settings.php").read_text(),(ROOT/"src/nav-dropdowns.css").read_text())
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix.lower()==".png": continue
        try:value=path.read_text(encoding="utf-8")
        except UnicodeDecodeError:continue
        need(not value.startswith(("\n","\r")),"leading blank line "+str(path.relative_to(ROOT)))
        need(value.endswith("\n") and not value.endswith("\n\n"),"EOF newline "+str(path.relative_to(ROOT)))
    php=shutil.which("php");node=shutil.which("node");need(php is not None,"php unavailable");need(node is not None,"node unavailable")
    run([php,"-l",str(ROOT/"src/provider.php")]);run([php,"-l",str(ROOT/"src/settings.php")])
    with tempfile.TemporaryDirectory() as td:
        td=Path(td)
        for n in ["NavDropdownMenus.page","NavDropdownMenusSettings.page"]:
            s=(ROOT/"src"/n).read_text();need("---\n" in s,"page delimiter "+n)
            f=td/(n+".php");f.write_text(s.split("---\n",1)[1]);run([php,"-l",str(f)])
        d=td/"vars.php";d.write_text("""<?php
$src=file_get_contents($argv[1]);$parts=explode("---\\n",$src,2);$tokens=token_get_all("<?php\\n".$parts[1]);$depth=0;$vars=[];
foreach($tokens as $tok){if(is_string($tok)){if($tok==='{')$depth++;elseif($tok==='}')$depth--;}elseif($tok[0]===T_VARIABLE&&$depth===0){$vars[$tok[1]]=true;}}
ksort($vars);echo implode(",",array_keys($vars));?>""")
        got=run([php,str(d),str(ROOT/"src/NavDropdownMenus.page")]).stdout.strip();need(got=="$jndBootstrap,$jndJsonFlags","top-level vars: "+got)
    run([node,"--check",str(ROOT/"src/nav-dropdowns.js")])
def selftest():
    good="\n".join([f'<!ENTITY version "{VERSION}">',f'<!ENTITY pluginURL "{PLUGIN_URL}">',f'<!ENTITY supportURL "{SUPPORT_URL}">','<PLUGIN pluginURL="&pluginURL;" support="&supportURL;" min="7.3.2">'])
    metadata(good)
    for bad in [good.replace(VERSION,"9.9.9",1),good.replace(SUPPORT_URL,"https://example.invalid",1),good+"\n1.0.12"]:
        try:metadata(bad)
        except VError:continue
        raise VError("negative control accepted invalid metadata")
def main():
    ap=argparse.ArgumentParser();ap.add_argument("--self-test",action="store_true");a=ap.parse_args()
    try:
        if a.self_test:selftest();print("SELF_TEST=PASS")
        validate();print("VALIDATION=PASS");return 0
    except (VError,ET.ParseError,IndexError) as e:
        print("VALIDATION=FAIL: "+str(e),file=sys.stderr);return 1
if __name__=="__main__":raise SystemExit(main())
