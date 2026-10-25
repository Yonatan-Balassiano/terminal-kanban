#!/usr/bin/env python3
"""agentboard, as seen from inside a remote card.

The daemon mirrors this file to ~/.agentboard/bin/agentboard on the remote host
and forwards its own remote-RPC socket there over SSH (see remote-rpc.ts and
socket-forward.ts on the Mac). It is a client for that one board, not an
install: there is no daemon on this host, and none is started.

Python 3 and its standard library only, because the remote host is not
guaranteed a node on a non-login PATH and this has to work from a hook.

Only the commands an agent drives from a card are here. The daemon decides the
rest: every call carries this card's token, and the daemon pins who the call
is from, so this script cannot act as another card however it is invoked.
"""

import argparse
import json
import os
import re
import socket
import sys
import uuid

DEFAULT_SOCKET = os.path.expanduser("~/.agentboard/run/daemon.sock")
DEFAULT_TIMEOUT_S = 30
# notify pastes into a live pane and waits for it to take — minutes by design.
DELIVERY_TIMEOUT_S = 600
PR_TIMEOUT_S = 60
TOKEN_FILE = os.path.join(".agentboard", "rpc-token")
PR_URL_PATTERN = re.compile(r"https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/(\d+)")


class CliError(Exception):
    pass


def socket_path():
    return os.environ.get("AGENTBOARD_REMOTE_SOCKET") or DEFAULT_SOCKET


def find_token():
    """$AGENTBOARD_RPC_TOKEN, else the marker the bootstrap drops in the worktree.

    The file is the fallback for a sandboxed Bash call that did not inherit the
    session's environment, walking up from the cwd the same way the Mac CLI
    finds .agentboard/task-id.
    """
    token = os.environ.get("AGENTBOARD_RPC_TOKEN", "").strip()
    if token:
        return token
    directory = os.getcwd()
    while True:
        candidate = os.path.join(directory, TOKEN_FILE)
        try:
            with open(candidate, encoding="utf-8") as handle:
                token = handle.read().strip()
            if token:
                return token
        except OSError:
            pass
        parent = os.path.dirname(directory)
        if parent == directory:
            return None
        directory = parent


def caller_task_id(token):
    return token.rsplit(".", 1)[0] if token and "." in token else None


def call(method, params=None, timeout=DEFAULT_TIMEOUT_S, token=None):
    request = {"id": str(uuid.uuid4()), "method": method, "params": params or {}}
    if token:
        request["token"] = token
    path = socket_path()
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        try:
            sock.connect(path)
        except OSError as error:
            raise CliError(
                f"Cannot reach the AgentBoard daemon at {path} ({error.strerror or error}). "
                "The socket is forwarded from the Mac while a remote card is open; "
                "run `agentboard doctor` on the Mac to check the forward."
            )
        sock.sendall((json.dumps(request) + "\n").encode("utf-8"))
        buffer = b""
        while b"\n" not in buffer:
            chunk = sock.recv(65536)
            if not chunk:
                raise CliError("The daemon closed the connection without answering.")
            buffer += chunk
    except socket.timeout:
        raise CliError(f"Timed out waiting for the daemon to answer {method}.")
    finally:
        sock.close()
    response = json.loads(buffer.split(b"\n", 1)[0].decode("utf-8"))
    if response.get("error"):
        raise CliError(response["error"].get("message", "Unknown error"))
    return response.get("result")


def authed_call(method, params=None, timeout=DEFAULT_TIMEOUT_S):
    token = find_token()
    if not token:
        raise CliError(
            "No AgentBoard card token here: run this from inside a remote card "
            "($AGENTBOARD_RPC_TOKEN, or .agentboard/rpc-token in its worktree)."
        )
    return call(method, params, timeout, token)


def print_table(header, rows, empty):
    if not rows:
        print(empty)
        return
    rows = [[str(cell) for cell in row] for row in rows]
    widths = [max([len(h)] + [len(r[i]) for r in rows]) for i, h in enumerate(header)]
    fmt = lambda cols: "  ".join(c.ljust(widths[i]) for i, c in enumerate(cols))  # noqa: E731
    print(fmt(header))
    print("  ".join("-" * w for w in widths))
    for row in rows:
        print(fmt(row))


def resolve_ref(candidates, ref, kind):
    for candidate in candidates:
        if candidate["id"] == ref:
            return candidate
    needle = ref.strip().lower()
    matches = [c for c in candidates if c.get("label", "").lower() == needle]
    if len(matches) == 1:
        return matches[0]
    known = ", ".join(f"{c['id']} ({c.get('label', '')})" for c in candidates) or "none"
    if matches:
        raise CliError(f'Ambiguous {kind} "{ref}" — more than one matches. Use an id: {known}')
    raise CliError(f'Unknown {kind} "{ref}". Known {kind}s: {known}')


def compose_brief(description, context_file, plan_url):
    parts = []
    if description:
        parts.append(description.strip())
    if context_file:
        try:
            with open(context_file, encoding="utf-8") as handle:
                contents = handle.read().strip()
        except OSError:
            raise CliError(f"Context file not found: {context_file}")
        if contents:
            parts.append(contents)
    if plan_url:
        parts.append(f"Read the plan at {plan_url} and execute it." if not parts else f"Plan: {plan_url}")
    brief = "\n\n".join(parts).strip()
    return brief or None


# ---------------- commands ----------------


def cmd_ls(args):
    board = authed_call("getBoard", {"repoId": args.repo} if args.repo else {})
    tasks = board["tasks"]
    if args.json:
        print(json.dumps(tasks, indent=2))
        return
    print_table(
        ["ID", "Title", "Track", "PR", "CI"],
        [[t["id"], t["title"], t["trackId"], t.get("prState"), t.get("ciState")] for t in tasks],
        "No tasks found.",
    )


def cmd_fleet(args):
    sessions = authed_call("getFleetStatus")["sessions"]
    if args.json:
        print(json.dumps(sessions, indent=2))
        return
    print_table(
        ["TASK", "TITLE", "SLOT", "BACKEND", "STATUS", "BUSY", "ATTENTION", "PANE"],
        [
            [
                s["taskId"],
                s["taskTitle"],
                s["slot"],
                s["backendType"],
                s["sessionStatus"],
                "yes" if s.get("isBusy") else "no",
                "yes" if s.get("attentionNeeded") else "no",
                s.get("paneId") or "-",
            ]
            for s in sessions
        ],
        "No live sessions.",
    )


def cmd_repos_ls(args):
    repos = authed_call("listRepos")
    if args.json:
        print(json.dumps(repos, indent=2))
        return
    print_table(
        ["ID", "Label", "Remote path"],
        [[r["id"], r["label"], r.get("remotePath") or "-"] for r in repos],
        "No repos registered.",
    )


def cmd_task_create(args):
    if args.general and args.repo:
        raise CliError("--general takes no --repo: a general task belongs to no repo.")
    if args.general and args.location == "remote":
        raise CliError("A general task has no checkout to run remotely; use --location local.")
    brief = compose_brief(args.description, args.context_file, args.plan_url)

    board = authed_call("getBoard")
    track_ids = [t["id"] for t in board["tracks"]]
    if args.track not in track_ids:
        raise CliError(f'Unknown --track "{args.track}". Known tracks: {", ".join(track_ids)}')

    repo = None
    if not args.general:
        if args.repo:
            repo = resolve_ref(board["repos"], args.repo, "repo")
        elif len(board["repos"]) == 1:
            repo = board["repos"][0]
        else:
            known = ", ".join(f"{r['id']} ({r['label']})" for r in board["repos"]) or "none"
            raise CliError(f"Pass --repo <id|label>, or --general for a task with no repo. Known repos: {known}")
        if args.location == "remote" and not repo.get("remotePath"):
            raise CliError(
                f"Repo {repo['id']} has no remotePath configured, so it cannot run remotely. "
                "Pass --location local to run it on the Mac."
            )

    pillar_id = resolve_ref(board["pillars"], args.pillar, "pillar")["id"] if args.pillar else (
        repo.get("defaultPillarId") if repo else None
    )
    params = {
        "title": args.title,
        "kind": "general" if args.general else "repo",
        "sessionName": args.session_name,
        "repoId": repo["id"] if repo else None,
        "pillarId": pillar_id,
        "agentCli": args.agent,
        "location": args.location,
        "trackId": args.track,
        "description": brief,
        "initialPrompt": brief,
    }
    # The daemon links it under this card when no --parent is given, and
    # refuses a --parent outside this card's own family.
    if args.parent:
        params["parentTaskId"] = args.parent
    created = authed_call("createTask", {k: v for k, v in params.items() if v is not None})
    session = authed_call("openSession", {"taskId": created["id"]}, timeout=60) if args.start else None

    if args.json:
        print(json.dumps({"task": created, "session": session}, indent=2))
        return
    print(f"Created task {created['id']}: {created['title']}")
    print(f"  task    {created['id']}")
    if created.get("branchName"):
        print(f"  branch  {created['branchName']}")
    print(f"  repo    {created.get('repoId') or '(general)'}")
    print(f"  agent   {created['agentCli']} ({created['location']})")
    if created.get("sessionName"):
        print(f"  session {created['sessionName']}")
    if created.get("parentTaskId"):
        print(f"  subtask of {created['parentTaskId']}")
    if brief:
        print(f"  brief   {brief.splitlines()[0]}")
    print("Session started." if session else f"Not started. Pass --start, or open it from the board.")


def cmd_task_notify(args):
    board = authed_call("getBoard")
    if not any(t["id"] == args.id for t in board["tasks"]):
        raise CliError(f'Unknown task "{args.id}". No card with that id exists.')
    print("Delivering — waiting for the pane to take it. This can take a few minutes.", flush=True)
    outcome = authed_call(
        "notifyTaskSession", {"taskId": args.id, "message": args.message}, timeout=DELIVERY_TIMEOUT_S
    )
    if outcome.get("delivered"):
        print(f"Delivered to {args.id}'s live session.")
    elif outcome.get("queued"):
        print(f"Queued for {args.id} — it will be delivered when that card's session next opens.")
    elif outcome.get("landedUnsubmitted"):
        print(
            f"Task {args.id}: the message reached the pane's input box but was never submitted. "
            "Do not re-send it — that stacks a second copy. Ask for the card to be restarted "
            f"(agentboard task restart {args.id}, on the Mac)."
        )
        return 1
    else:
        print(f"Task {args.id}: nothing was delivered.")
        return 1
    return 0


def cmd_task_attach_pr(args):
    try:
        pr_number = int(args.pr_number)
    except ValueError:
        pr_number = 0
    if pr_number <= 0:
        raise CliError(f'Invalid PR number "{args.pr_number}".')
    board = authed_call("getBoard")
    task = next((t for t in board["tasks"] if t["id"] == args.task), None)
    if not task:
        raise CliError(f'Unknown task "{args.task}". No card with that id exists.')
    if task.get("kind") == "general":
        raise CliError(f"Task {args.task} is a general card — it has no repo to attach a PR to.")
    repo = (
        resolve_ref(board["repos"], args.repo, "repo")
        if args.repo
        else next((r for r in board["repos"] if r["id"] == task.get("repoId")), None)
    )
    if not repo:
        raise CliError("Pass --repo <id|label> — this card has no repo of its own to default to.")
    params = {"taskId": args.task, "repoId": repo["id"], "prNumber": pr_number}
    if args.base:
        params["baseBranch"] = args.base
    authed_call("addTaskBranch", params, timeout=PR_TIMEOUT_S)
    print(f"Attached PR #{pr_number} from {repo['label']} to task {args.task}. Sync will fill in its state shortly.")


def reported_prs(raw):
    """parsePrReportHookInput (pr-report.ts), line for line: only URLs the call printed."""
    try:
        payload = json.loads(raw)
    except ValueError:
        return []
    if not isinstance(payload, dict) or payload.get("tool_name") != "Bash":
        return []
    command = (payload.get("tool_input") or {}).get("command")
    if not isinstance(command, str) or not re.search(r"\bgh\s+pr\s+create\b", command):
        return []
    response = payload.get("tool_response")
    if isinstance(response, str):
        output = response
    elif isinstance(response, dict):
        output = "\n".join(p for p in (response.get("stdout"), response.get("stderr")) if isinstance(p, str))
    else:
        output = ""
    found = {}
    for owner, repo, number in PR_URL_PATTERN.findall(output):
        found[f"{owner}/{repo}#{number}".lower()] = (owner, repo, int(number))
    return list(found.values())


def cmd_task_report_pr(args):
    # A hook: silent, and never a failure the agent's tool call would see.
    try:
        prs = reported_prs(sys.stdin.read())
        if not prs:
            return 0
        board = authed_call("getBoard")
        card = next((t for t in board["tasks"] if t["id"] == args.task), None)
        if not card or card.get("kind") == "general":
            return 0
        for owner, name, number in prs:
            repo = next(
                (
                    r
                    for r in board["repos"]
                    if (r.get("githubOwner") or "").lower() == owner.lower()
                    and (r.get("githubRepo") or "").lower() == name.lower()
                ),
                None,
            )
            if not repo or any(
                b.get("repoId") == repo["id"] and b.get("prNumber") == number for b in card.get("branches", [])
            ):
                continue
            try:
                authed_call("addTaskBranch", {"taskId": args.task, "repoId": repo["id"], "prNumber": number}, PR_TIMEOUT_S)
            except CliError:
                pass
    except Exception:  # noqa: BLE001 — the sync loop's own search is the backstop
        pass
    return 0


def cmd_ping(args):
    """Used by `agentboard doctor` on the Mac: is the forwarded socket answering?"""
    status = call("daemonStatus", timeout=10)
    token = find_token()
    print(f"ok pid={status.get('pid')} card={caller_task_id(token) or '-'}")


def build_parser():
    parser = argparse.ArgumentParser(
        prog="agentboard",
        description="AgentBoard from inside a remote card — talks to the Mac board over a forwarded socket.",
    )
    sub = parser.add_subparsers(dest="command", metavar="<command>")

    ls = sub.add_parser("ls", help="List tasks on the board")
    ls.add_argument("--repo", help="Filter by repo ID")
    ls.add_argument("--json", action="store_true")
    ls.set_defaults(handler=cmd_ls)

    fleet = sub.add_parser("fleet", help="List every live session and its state")
    fleet.add_argument("--json", action="store_true")
    fleet.set_defaults(handler=cmd_fleet)

    repos = sub.add_parser("repos", help="Repositories").add_subparsers(dest="repos_command", metavar="<command>")
    repos_ls = repos.add_parser("ls", help="List registered repos")
    repos_ls.add_argument("--json", action="store_true")
    repos_ls.set_defaults(handler=cmd_repos_ls)

    task = sub.add_parser("task", help="Manage tasks on the board").add_subparsers(dest="task_command", metavar="<command>")

    create = task.add_parser("create", help="Create a task (a subtask of this card unless --parent says otherwise)")
    create.add_argument("title")
    create.add_argument("--repo")
    create.add_argument("--general", action="store_true")
    create.add_argument("--parent", help="This card or one of its subtasks; defaults to this card")
    create.add_argument("--session-name")
    create.add_argument("--pillar")
    create.add_argument("--agent", choices=["claude", "codex"], default="claude")
    # A card spun off from a remote card runs where its parent does unless told otherwise.
    create.add_argument("--location", choices=["local", "remote"], default="remote")
    create.add_argument("--track", default="backlog")
    create.add_argument("--description")
    create.add_argument("--context-file")
    create.add_argument("--plan-url")
    create.add_argument("--start", action="store_true")
    create.add_argument("--json", action="store_true")
    create.set_defaults(handler=cmd_task_create)

    notify = task.add_parser("notify", help="Send a message into another card's session")
    notify.add_argument("id")
    notify.add_argument("message")
    notify.set_defaults(handler=cmd_task_notify)

    attach = task.add_parser("attach-pr", help="Attach a pull request to a card by its number")
    attach.add_argument("task")
    attach.add_argument("pr_number")
    attach.add_argument("--repo")
    attach.add_argument("--base")
    attach.set_defaults(handler=cmd_task_attach_pr)

    report = task.add_parser("report-pr", help="Internal: the PostToolUse hook's PR report")
    report.add_argument("task")
    report.set_defaults(handler=cmd_task_report_pr)

    ping = sub.add_parser("ping", help="Check the forwarded daemon socket")
    ping.set_defaults(handler=cmd_ping)

    return parser


def main(argv):
    parser = build_parser()
    args, unknown = parser.parse_known_args(argv)
    handler = getattr(args, "handler", None)
    if handler is None or unknown:
        parser.print_help(sys.stderr)
        print(
            "\nOnly these commands are available from a remote card; the rest of "
            "agentboard runs on the Mac, where the board is.",
            file=sys.stderr,
        )
        return 2
    try:
        return handler(args) or 0
    except CliError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
