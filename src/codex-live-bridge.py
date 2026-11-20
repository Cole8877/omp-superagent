#!/usr/bin/env python3
# The Gateway runs this with the Python environment installed from codex-voice-requirements.txt.
# The Bun adapter owns the private stdin/stdout pipes; the bridge is not a CLI.

from __future__ import annotations

import json
import logging
import sys
from functools import partial
from typing import Final

import anyio
from anyio.abc import ObjectSendStream

from codex_live_auth import read_codex_login
from codex_live_media import COMMANDS, CONTEXT, BridgeEvent, Command, run_peer
from codex_live_provider import VOICES, BridgeError, connect_subscription

MAX_LINE: Final = 65_536


def emit(event: BridgeEvent) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


async def read_commands(send: ObjectSendStream[Command], scope: anyio.CancelScope) -> None:
    async with send:
        while True:
            line = await anyio.to_thread.run_sync(sys.stdin.buffer.readline, MAX_LINE + 1, abandon_on_cancel=True)
            if not line or line == b'{"type":"stop"}\n':
                scope.cancel()
                return
            if len(line) > MAX_LINE or not line.endswith(b"\n"):
                raise BridgeError("Invalid voice bridge command frame.")
            await send.send(COMMANDS.validate_json(line))


async def read_context() -> str:
    line = await anyio.to_thread.run_sync(sys.stdin.buffer.readline, MAX_LINE + 1)
    if len(line) > MAX_LINE or not line.endswith(b"\n"):
        raise BridgeError("Invalid voice bridge context frame.")
    return CONTEXT.validate_json(line).text


async def run(voice: str, with_context: bool) -> None:
    if voice not in VOICES:
        raise BridgeError("Unsupported Codex subscription voice.")
    context = await read_context() if with_context else ""
    send, commands = anyio.create_memory_object_stream[Command](16)
    async with commands, anyio.create_task_group() as tasks:
        tasks.start_soon(read_commands, send, tasks.cancel_scope)
        try:
            login = await read_codex_login()
            if any(secret.get_secret_value() in context for secret in (login.token, login.account_id)):
                raise BridgeError("Voice context contained a credential.")
            negotiate = partial(connect_subscription, voice=voice, login=login, context=context)
            await run_peer(negotiate, (commands, emit), (login.token, login.account_id))
        finally:
            tasks.cancel_scope.cancel()


def main() -> None:
    # Dependency exceptions can include response bodies, SDP or headers.
    # The parent sees only this closed event or EOF, never raw diagnostics.
    logging.disable(logging.CRITICAL)
    exit_status = 0
    try:
        if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != "context"):
            raise BridgeError("Codex voice needs a voice identifier.")
        anyio.run(run, sys.argv[1], len(sys.argv) == 3)
    except Exception:  # Top-level subprocess trust boundary: fail closed without exposing wire data.
        exit_status = 1
    try:
        emit({"type": "ended"})
    except BrokenPipeError:
        sys.exit(exit_status)  # The parent already stopped reading.
    sys.exit(exit_status)


if __name__ == "__main__":
    main()
