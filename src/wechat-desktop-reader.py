"""Read a page of the operator-approved Codex Desktop catalog for a signed owner DM."""
import json
import os
import re
import sqlite3
import stat
import sys
import unicodedata
from pathlib import Path

DENIED_NAMES = {
    "node_modules", "__pycache__", "backups", "credentials", "secrets", "keychain",
    "auth.json", "login.json", "status.json", "verification-code.txt",
}
SECRET_SUFFIXES = (".sqlite", ".sqlite3", ".sqlite-wal", ".sqlite-shm", ".db", ".pem",
                   ".key", ".p12", ".pfx", ".secret", ".log", ".keychain-db")


def norm(value):
    return unicodedata.normalize("NFKC", str(value)).casefold()


def below(value, root):
    return norm(value) == norm(root) or norm(value).startswith(norm(root).rstrip("/") + "/")


def bounded_page(parts, page, size):
    start = (page - 1) * size
    end = start + size
    seen = 0
    out = []
    for value in parts:
        limit = seen + len(value)
        if limit > start:
            out.append(value[max(0, start - seen):end - seen])
        if limit > end:
            return "".join(out) + f"\n（下一页 @{page + 1}）"
        seen = limit
    return "".join(out) or "本页无内容。"


def visible(name):
    s = norm(name)
    return (s and not s.startswith(".") and s not in DENIED_NAMES
            and not s.endswith(SECRET_SUFFIXES) and not any(ord(ch) < 32 for ch in name))


def file_parts(project, relative, listing, forbidden):
    root = project["path"]
    parts = relative.split("/") if relative else []
    if any(not visible(p) for p in parts):
        raise ValueError()
    directory = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(root, directory)
    try:
        root_stat = os.fstat(fd)
        if (root_stat.st_dev, root_stat.st_ino) != (project["device"], project["inode"]):
            raise ValueError()
        current = Path(root)
        for i, name in enumerate(parts):
            current = current / name
            if forbidden(current):
                raise ValueError()
            flags = directory if listing or i < len(parts) - 1 else os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
            child = os.open(name, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        if listing:
            for name in sorted(os.listdir(fd)):
                if not visible(name) or forbidden(current / name):
                    continue
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    yield name + "/\n"
                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                    yield name + "\n"
        else:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 8 * 1024 * 1024:
                raise ValueError()
            with os.fdopen(os.dup(fd), encoding="utf-8") as f:
                while chunk := f.read(8192):
                    if "\x00" in chunk:
                        raise ValueError()
                    yield chunk
    finally:
        os.close(fd)


def json_records(f):
    # Binary attachments in historical tool results can be much larger than a message.
    limit = 4 * 1024 * 1024
    while raw := f.readline(limit):
        if len(raw) == limit and not raw.endswith(b"\n"):
            while raw and not raw.endswith(b"\n"):
                raw = f.readline(limit)
            continue
        try:
            yield json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            continue


def transcript(row, home, allowed_thread, title_only=False):
    file = Path(row["rollout_path"])
    if not file.is_absolute() or file.resolve(strict=True) != file or not any(
        file.is_relative_to(home / subdir) for subdir in ("sessions", "archived_sessions")
    ) or not file.name.endswith(row["id"] + ".jsonl"):
        raise ValueError()
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as f:
        info = os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError()
        records = json_records(f)
        first = next(records)
        meta = first.get("payload", {})
        if first.get("type") != "session_meta" or meta.get("id") != row["id"] or not allowed_thread(meta):
            raise ValueError()
        if title_only:
            yield row["name"] or row["title"] or "无标题"
            return
        for rec in records:
            if rec.get("type") != "event_msg":
                continue
            payload = rec.get("payload") or {}
            kind = payload.get("type")
            if kind == "item_completed":
                item = payload.get("item") or {}
                role = item.get("type")
                if role not in ("UserMessage", "AgentMessage") or item.get("phase") == "commentary":
                    continue
                text = "\n".join(block["text"] for block in item.get("content", [])
                                 if isinstance(block.get("text"), str))
            elif kind in ("user_message", "agent_message"):
                role = "UserMessage" if kind == "user_message" else "AgentMessage"
                text = payload.get("message", "")
            else:
                continue
            if text:
                yield ("老板：" if role == "UserMessage" else "助手：") + text + "\n"


def read_page(req):
    home = Path(req["home"])
    policy = req["policy"]
    query = req["query"]
    action, target = query["action"], query["target"]
    excluded = [str(Path(p).resolve()) for p in req["deniedPaths"]]

    def forbidden(p):
        return any(below(p, d) for d in excluded) or any(norm(x) in (".data", ".tools", ".trash") for x in Path(p).parts)

    def allowed_thread(row):
        cwd = row.get("cwd")
        roots = row.get("runtime_workspace_roots") or []
        return (row.get("creator_user_id") == policy["creatorUser"] and row.get("creator_account_id") == policy["creatorAccount"]
                and bool(policy["creatorUser"] and policy["creatorAccount"]) and row.get("originator") == "Codex Desktop"
                and row.get("source") == "vscode" and cwd and Path(cwd).is_absolute()
                and all(isinstance(r, str) and Path(r).is_absolute() and not forbidden(r) and not forbidden(Path(r).resolve())
                        for r in [cwd, *roots]))

    db = sqlite3.connect((home / "state_5.sqlite").as_uri() + "?mode=ro", uri=True, timeout=1)
    db.row_factory = sqlite3.Row
    live = {(r["project_id"], r["path"]): r["name"] for r in db.execute(
        "SELECT r.project_id,r.path,p.name FROM project_roots r JOIN projects p ON p.id=r.project_id")}
    projects = {}
    for p in policy["projects"]:
        name = live.get((p["id"], p["path"]))
        if name and not forbidden(p["path"]):
            projects[p["key"]] = {**p, "name": name}
    project = projects.get(target)
    if action == "desktop":
        parts = (f'{p["name"]} {key}\n' for key, p in projects.items())
    elif action in ("files", "file") and project:
        parts = file_parts(project, query["relative"], action == "files", forbidden)
    elif action in ("chats", "chat", "target"):
        if action == "chats" and not (target == "desktop" or project):
            raise ValueError()
        ids = set(req["managedThreads"])
        sql = ("SELECT id,name,title,cwd,source,originator,creator_user_id,creator_account_id,rollout_path FROM threads "
               "WHERE creator_user_id=? AND creator_account_id=? AND originator='Codex Desktop' AND source='vscode'")
        args = [policy["creatorUser"], policy["creatorAccount"]]
        if action in ("target", "chat"):
            if not re.fullmatch(r"d-[\da-fA-F-]{36}", target):
                raise ValueError()
            sql += " AND id=?"
            args.append(target[2:])
        rows = (dict(r) for r in db.execute(sql + " ORDER BY updated_at DESC,id", args))
        rows = (r for r in rows if r["id"] not in ids and allowed_thread(r) and (not project or below(r["cwd"], project["path"])))
        if action == "target":
            row = next(rows)
            title = next(transcript(row, home, allowed_thread, title_only=True))
            return json.dumps({"title": title[:300], "id": row["id"], "file": row["rollout_path"], "cwd": row["cwd"]})
        if action == "chat":
            parts = transcript(next(rows), home, allowed_thread)
        else:
            def titles():
                for row in rows:
                    try:
                        title = next(transcript(row, home, allowed_thread, title_only=True))
                    except (ValueError, OSError, StopIteration):
                        continue
                    yield f'{title} d-{row["id"]}\n'
            parts = titles()
    else:
        raise ValueError()
    return bounded_page(parts, query["page"], req["pageSize"])


if __name__ == "__main__":
    try:
        print(json.dumps({"text": read_page(json.load(sys.stdin))}, ensure_ascii=False))
    except Exception:
        sys.exit(1)
