#!/usr/bin/env python3
"""
Convert the original Tinker-FFE catalogs (commands.xml, keywords.xml) into the
JSON the new UI consumes. Run once to (re)generate src/renderer/src/data/*.json:

    python3 scripts/convert-tinker-xml.py

Reads from the reference clone at ../tinker-ffe-original (sibling of the app dir).
"""

import json
import os
import re
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
ORIG = os.path.join(APP, "..", "tinker-ffe-original", "source", "ffe", "src", "main", "java", "ffe", "tinker")
OUT = os.path.join(APP, "src", "renderer", "src", "data")


def clean(text):
    if not text:
        return ""
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.replace("\r", "").split("\n")]
    out = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    return out


def convert_commands():
    root = ET.parse(os.path.join(ORIG, "commands.xml")).getroot()
    commands = []
    for cmd in root.findall("Command"):
        options = []
        for opt in cmd.findall("Option"):
            conditionals = [
                {
                    "value": c.get("value"),
                    "description": clean(c.get("description")),
                    "gui": c.get("gui"),
                    "default": c.get("default") or "",
                }
                for c in opt.findall("Conditional")
            ]
            options.append(
                {
                    "name": opt.get("name"),
                    "description": clean(opt.get("description")),
                    "gui": opt.get("gui"),
                    "default": opt.get("default") or "",
                    "values": [v.get("name") for v in opt.findall("Value")],
                    "conditionals": conditionals,
                }
            )
        commands.append(
            {
                "name": cmd.get("name"),
                "fileTypes": (cmd.get("fileType") or "").split(),
                "actions": (cmd.get("action") or "").split(),
                "description": clean(cmd.get("description")),
                "options": options,
            }
        )
    return commands


def convert_keywords():
    root = ET.parse(os.path.join(ORIG, "keywords.xml")).getroot()
    sections = []
    for sec in root.iter("section"):
        keywords = [
            {
                "name": sub.get("name"),
                "rep": sub.get("rep"),
                "description": clean(sub.text),
                "values": [v.get("name") for v in sub.findall("Value")],
            }
            for sub in sec.findall("subsection")
        ]
        sections.append({"name": sec.get("name"), "keywords": keywords})
    return sections


def main():
    os.makedirs(OUT, exist_ok=True)
    commands = convert_commands()
    keywords = convert_keywords()
    with open(os.path.join(OUT, "commands.json"), "w") as f:
        json.dump(commands, f, indent=2)
    with open(os.path.join(OUT, "keywords.json"), "w") as f:
        json.dump(keywords, f, indent=2)
    print(f"commands: {len(commands)} programs")
    print(f"keywords: {len(keywords)} sections, {sum(len(s['keywords']) for s in keywords)} keywords")


if __name__ == "__main__":
    main()
