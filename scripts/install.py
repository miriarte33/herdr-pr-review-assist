#!/usr/bin/env python3
"""Install the panel into the current personal Herdr layout, preserving shipped mods."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

source = Path(__file__).resolve().parents[1]
home = Path(os.environ.get("HERDR_APP_HOME", Path.home() / ".config/herdr-app"))

def command(*args):
    return json.loads(subprocess.check_output(["herdr-app", *args], text=True))

def find(node, id):
    if node.get("id") == id:
        return node
    return next((r for c in node.get("children", []) if (r := find(c, id))), None)

status = command("status")
name = status["layout"]
path = home / "layouts" / f"{name}.json"
layout = json.loads(path.read_text())
if name in ("main", "terminals", "win98"):
    name = f"{name}-pr-review-assist"
    command("do", "layout.clone", json.dumps({"name": status["layout"], "as": name}))
    path = home / "layouts" / f"{name}.json"
    layout = json.loads(path.read_text())
bar, body = find(layout, "tabs"), find(layout, "panel-body")
if not bar or not body or not find(layout, "panel"):
    raise SystemExit("This installer needs a tabs block, panel, and panel-body stack. See RECIPE.md for manual integration.")

target = home / "mods/pr-review-assist"
if target.exists() and (target / "main.js").read_text() != (source / "mods/pr-review-assist/main.js").read_text():
    (home / "backups").mkdir(exist_ok=True)
    shutil.copytree(target, home / f"backups/pr-review-assist-{time.time_ns()}")
shutil.copytree(source / "mods/pr-review-assist", target, dirs_exist_ok=True)
subprocess.run(["herdr-app", "check", str(target)], check=True)

# Keep every existing tab behavior. A private clone is required for shipped code.
original = bar["content"]["mod"]
clone = "pr-review-assist-tabs"
if original != clone:
    command("do", "mod.clone", json.dumps({"name": original, "as": clone}))
bar_path = home / "mods" / clone / "main.js"
code = bar_path.read_text()
anchor = '      .when(w?.buttons, el =>'
button = '      .child(panelButton("pr-review-assist", "View PRs", "mods/pr-review-assist/pr.svg"))\n'
if 'panelButton("pr-review-assist"' not in code:
    if anchor not in code:
        raise SystemExit("Tab bar differs from the expected native bar; integrate the View PRs button manually per RECIPE.md.")
    code = code.replace(anchor, button + anchor, 1)
# The tab bar remembers the panel per space; allow this panel through restoration.
code = code.replace('const enabled = shared("workspace.panels") ?? ["files", "changes"];',
                    'const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "pr-review-assist"];')
bar_path.write_text(code)
subprocess.run(["herdr-app", "check", str(bar_path.parent)], check=True)
shutil.copy2(path, path.with_name(path.name + f".before-pr-review-assist-{time.time_ns()}"))
bar["content"]["mod"] = clone
new_panel = not find(layout, "pr-review-assist")
if new_panel:
    body["children"].append({"id": "pr-review-assist", "type": "block", "content": {"mod": "pr-review-assist"}})
path.write_text(json.dumps(layout, indent=2) + "\n")
if new_panel:
    command("do", "layout.resize", json.dumps({"id": "panel", "px": 420}))
print(f"Installed PR Review Assist into {name}. View PRs is to the right of Changes.")
