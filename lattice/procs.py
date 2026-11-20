"""Supervised child processes (llama-server, ggml-rpc-server).

Children are placed in a Windows Job Object configured with KILL_ON_JOB_CLOSE, so
they die with Lattice even if Lattice crashes or the terminal window is closed.
"""
from __future__ import annotations

import asyncio
import ctypes
import os
import subprocess
import sys
import time
from collections import deque
from ctypes import wintypes
from pathlib import Path
from typing import Callable

from .hub import Hub


class _JobObject:
    def __init__(self) -> None:
        self.handle = None
        if sys.platform != "win32":
            return
        try:
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.CreateJobObjectW.restype = wintypes.HANDLE
            k32.OpenProcess.restype = wintypes.HANDLE
            k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
            k32.CloseHandle.argtypes = [wintypes.HANDLE]

            class BASIC(ctypes.Structure):
                _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                            ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                            ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                            ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                            ("SchedulingClass", wintypes.DWORD)]

            class IO(ctypes.Structure):
                _fields_ = [(n, ctypes.c_uint64) for n in ("r", "w", "o", "rb", "wb", "ob")]

            class EXT(ctypes.Structure):
                _fields_ = [("Basic", BASIC), ("Io", IO), ("ProcessMemoryLimit", ctypes.c_size_t),
                            ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                            ("PeakJobMemoryUsed", ctypes.c_size_t)]

            h = k32.CreateJobObjectW(None, None)
            info = EXT()
            info.Basic.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            k32.SetInformationJobObject(h, 9, ctypes.byref(info), ctypes.sizeof(info))
            self.k32, self.handle = k32, h
        except OSError:
            self.handle = None

    def adopt(self, pid: int) -> None:
        if not self.handle:
            return
        ph = self.k32.OpenProcess(0x0100 | 0x0001, False, pid)  # SET_QUOTA | TERMINATE
        if ph:
            self.k32.AssignProcessToJobObject(self.handle, ph)
            self.k32.CloseHandle(ph)


JOB = _JobObject()


class ManagedProcess:
    def __init__(self, name: str, hub: Hub, max_lines: int = 3000) -> None:
        self.name = name
        self.hub = hub
        self.proc: asyncio.subprocess.Process | None = None
        self.lines: deque[str] = deque(maxlen=max_lines)
        self.args: list[str] = []
        self.started_at: float | None = None
        self.exit_code: int | None = None
        self.watchers: list[Callable[[str], None]] = []
        self._reader: asyncio.Task | None = None
        self.log_file: Path | None = None

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    @property
    def pid(self) -> int | None:
        return self.proc.pid if self.running else None

    async def start(self, args: list[str], cwd: Path, env: dict | None = None, log_file: Path | None = None) -> None:
        if self.running:
            await self.stop()
        self.args = [str(a) for a in args]
        self.exit_code = None
        self.lines.clear()
        self.log_file = log_file
        full_env = dict(os.environ)
        full_env.update(env or {})
        kwargs = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        self._append(f"$ {' '.join(self.args)}")
        self.proc = await asyncio.create_subprocess_exec(
            *self.args, cwd=str(cwd), env=full_env,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT, **kwargs)
        JOB.adopt(self.proc.pid)
        self.started_at = time.time()
        self._reader = asyncio.create_task(self._pump())

    def _append(self, line: str) -> None:
        self.lines.append(line)
        if self.log_file:
            try:
                with open(self.log_file, "a", encoding="utf-8", errors="replace") as f:
                    f.write(line + "\n")
            except OSError:
                pass
        self.hub.emit("log", {"proc": self.name, "line": line})
        for w in list(self.watchers):
            try:
                w(line)
            except Exception:
                pass

    async def _pump(self) -> None:
        assert self.proc and self.proc.stdout
        while True:
            raw = await self.proc.stdout.readline()
            if not raw:
                break
            self._append(raw.decode("utf-8", errors="replace").rstrip())
        self.exit_code = await self.proc.wait()
        self._append(f"[process exited with code {self.exit_code}]")

    async def stop(self, timeout: float = 5.0) -> None:
        if not self.proc:
            return
        if self.proc.returncode is None:
            try:
                self.proc.terminate()
                await asyncio.wait_for(self.proc.wait(), timeout)
            except (ProcessLookupError, asyncio.TimeoutError):
                try:
                    self.proc.kill()
                except ProcessLookupError:
                    pass
            except Exception:
                pass
        if self._reader:
            try:
                await asyncio.wait_for(self._reader, 2)
            except Exception:
                pass
        self.proc = None

    def tail(self, n: int = 40) -> list[str]:
        return list(self.lines)[-n:]

    def status(self) -> dict:
        return {
            "name": self.name, "running": self.running, "pid": self.pid,
            "started_at": self.started_at, "exit_code": self.exit_code, "args": self.args,
        }
