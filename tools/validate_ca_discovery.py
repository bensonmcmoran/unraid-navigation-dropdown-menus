from pathlib import Path
import re, sys, xml.etree.ElementTree as ET
R=Path(".")
URL="https://raw.githubusercontent.com/bensonmcmoran/unraid-navigation-dropdown-menus/main/nav.dropdown.menus.plg"
PROJ="https://github.com/bensonmcmoran/unraid-navigation-dropdown-menus"
SUP="https://forums.unraid.net/topic/200761-plugin-navigation-dropdown-menus/"
def need(x,m):
    if not x: raise AssertionError(m)
ca=ET.parse(R/"plugins/nav.dropdown.menus.xml").getroot()
need(ca.tag=="Plugin","root")
need(not (R/"nav.dropdown.menus.xml").exists(),"legacy root plugin metadata")
need(ca.findtext("PluginURL")==URL,"plugin URL")
need(ca.findtext("PluginAuthor")=="Furious Rage","author")
need(ca.findtext("Support")==SUP,"support")
need(ca.findtext("Project")==PROJ,"project")
need(ca.findtext("MinVer")=="7.3.2","minver")
need(ca.findtext("License")=="MIT","license")
shots=[x.text for x in ca.findall("Screenshot")]
need(shots==[f"https://raw.githubusercontent.com/bensonmcmoran/unraid-navigation-dropdown-menus/main/screenshots/screenshot{i}.png" for i in range(1,6)],"screenshots")
plg=(R/"nav.dropdown.menus.plg").read_text()
need('<!ENTITY author "Furious Rage">' in plg,"PLG author")
need('**Furious Rage**' in (R/"README.md").read_text(),"README author")
need('Copyright (c) 2026 Benson McMoran' in (R/"LICENSE").read_text(),"copyright")
print("CA_DISCOVERY_FOCUSED=PASS")
