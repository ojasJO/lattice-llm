"""Vendor-neutral GPU/CPU metrics on Windows via ctypes, no extra packages.

* DXGI   : adapter names, LUIDs and VRAM size (any vendor)
* PDH    : per-engine GPU utilisation incl. per-process attribution, adapter memory
           usage, effective CPU clock (shows thermal throttling)
* NVML   : temperature, power draw and clocks on NVIDIA GPUs (optional)

Everything degrades gracefully: on failure the corresponding fields are omitted.
"""
from __future__ import annotations

import ctypes
import re
import sys
from ctypes import POINTER, byref, c_void_p, wintypes

IS_WIN = sys.platform == "win32"


# --------------------------------------------------------------------------- DXGI
class _LUID(ctypes.Structure):
    _fields_ = [("LowPart", wintypes.DWORD), ("HighPart", wintypes.LONG)]


class _DXGI_ADAPTER_DESC1(ctypes.Structure):
    _fields_ = [
        ("Description", wintypes.WCHAR * 128),
        ("VendorId", wintypes.UINT),
        ("DeviceId", wintypes.UINT),
        ("SubSysId", wintypes.UINT),
        ("Revision", wintypes.UINT),
        ("DedicatedVideoMemory", ctypes.c_size_t),
        ("DedicatedSystemMemory", ctypes.c_size_t),
        ("SharedSystemMemory", ctypes.c_size_t),
        ("AdapterLuid", _LUID),
        ("Flags", wintypes.UINT),
    ]


class _GUID(ctypes.Structure):
    _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD), ("Data4", ctypes.c_ubyte * 8)]


_IID_IDXGIFactory1 = _GUID(0x770AAE78, 0xF26F, 0x4DBA,
                           (ctypes.c_ubyte * 8)(0xA8, 0x29, 0x25, 0x3C, 0x83, 0xD1, 0xB3, 0x87))
_VENDORS = {0x10DE: "NVIDIA", 0x1002: "AMD", 0x8086: "Intel", 0x1414: "Microsoft"}


def _vcall(obj: c_void_p, index: int, restype, *argtypes):
    vtbl = ctypes.cast(obj, POINTER(POINTER(c_void_p))).contents
    return ctypes.WINFUNCTYPE(restype, c_void_p, *argtypes)(vtbl[index])


def dxgi_adapters() -> list[dict]:
    if not IS_WIN:
        return []
    out: list[dict] = []
    try:
        dxgi = ctypes.WinDLL("dxgi")
        factory = c_void_p()
        dxgi.CreateDXGIFactory1(byref(_IID_IDXGIFactory1), byref(factory))
        if not factory.value:
            return []
        enum = _vcall(factory, 12, ctypes.HRESULT, ctypes.c_uint, POINTER(c_void_p))
        i = 0
        while i < 16:
            adapter = c_void_p()
            try:
                enum(factory, i, byref(adapter))
            except OSError:
                break  # DXGI_ERROR_NOT_FOUND
            desc = _DXGI_ADAPTER_DESC1()
            try:
                _vcall(adapter, 10, ctypes.HRESULT, POINTER(_DXGI_ADAPTER_DESC1))(adapter, byref(desc))
                if not desc.Flags & 2:  # skip DXGI_ADAPTER_FLAG_SOFTWARE
                    luid = f"luid_0x{desc.AdapterLuid.HighPart & 0xFFFFFFFF:08X}_0x{desc.AdapterLuid.LowPart:08X}"
                    out.append({
                        "name": desc.Description.strip(),
                        "vendor": _VENDORS.get(desc.VendorId, hex(desc.VendorId)),
                        "luid": luid.lower(),
                        "vram": int(desc.DedicatedVideoMemory),
                        "shared": int(desc.SharedSystemMemory),
                        "integrated": desc.DedicatedVideoMemory < 1 << 30 and desc.VendorId == 0x8086,
                    })
            finally:
                _vcall(adapter, 2, ctypes.c_ulong)(adapter)
            i += 1
        _vcall(factory, 2, ctypes.c_ulong)(factory)
    except Exception:  # pragma: no cover - best effort
        pass
    # de-duplicate (some drivers enumerate the same adapter twice)
    seen, uniq = set(), []
    for a in out:
        if a["luid"] not in seen:
            seen.add(a["luid"])
            uniq.append(a)
    return uniq


# --------------------------------------------------------------------------- PDH
class _PDH_FMT_COUNTERVALUE(ctypes.Structure):
    _fields_ = [("CStatus", wintypes.DWORD), ("doubleValue", ctypes.c_double)]


class _PDH_FMT_COUNTERVALUE_ITEM_W(ctypes.Structure):
    _fields_ = [("szName", wintypes.LPWSTR), ("FmtValue", _PDH_FMT_COUNTERVALUE)]


_PDH_FMT_DOUBLE = 0x00000200
_PDH_FMT_NOCAP100 = 0x00008000
_PDH_MORE_DATA = 0x800007D2
_ENGINE_RE = re.compile(r"pid_(\d+)_(luid_0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+_eng_(\d+)_engtype_(.*)", re.I)
_ADAPTER_RE = re.compile(r"(luid_0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+", re.I)


class Pdh:
    COUNTERS = {
        "gpu_engine": r"\GPU Engine(*)\Utilization Percentage",
        "gpu_dedicated": r"\GPU Adapter Memory(*)\Dedicated Usage",
        "gpu_shared": r"\GPU Adapter Memory(*)\Shared Usage",
        "cpu_perf": r"\Processor Information(_Total)\% Processor Performance",
        "cpu_freq": r"\Processor Information(_Total)\Processor Frequency",
    }

    def __init__(self) -> None:
        self.ok = False
        self.counters: dict[str, c_void_p] = {}
        if not IS_WIN:
            return
        try:
            self.pdh = ctypes.WinDLL("pdh")
            p = self.pdh
            p.PdhOpenQueryW.argtypes = [wintypes.LPCWSTR, ctypes.c_size_t, POINTER(c_void_p)]
            p.PdhOpenQueryW.restype = ctypes.c_uint32
            p.PdhAddEnglishCounterW.argtypes = [c_void_p, wintypes.LPCWSTR, ctypes.c_size_t, POINTER(c_void_p)]
            p.PdhAddEnglishCounterW.restype = ctypes.c_uint32
            p.PdhCollectQueryData.argtypes = [c_void_p]
            p.PdhCollectQueryData.restype = ctypes.c_uint32
            p.PdhGetFormattedCounterArrayW.argtypes = [c_void_p, wintypes.DWORD, POINTER(wintypes.DWORD),
                                                       POINTER(wintypes.DWORD), c_void_p]
            p.PdhGetFormattedCounterArrayW.restype = ctypes.c_uint32
            self.query = c_void_p()
            if p.PdhOpenQueryW(None, 0, byref(self.query)) != 0:
                return
            for key, path in self.COUNTERS.items():
                h = c_void_p()
                if p.PdhAddEnglishCounterW(self.query, path, 0, byref(h)) == 0:
                    self.counters[key] = h
            p.PdhCollectQueryData(self.query)  # prime rate counters
            self.ok = bool(self.counters)
        except OSError:
            self.ok = False

    def _array(self, key: str) -> dict[str, float]:
        h = self.counters.get(key)
        if h is None:
            return {}
        fmt = _PDH_FMT_DOUBLE | _PDH_FMT_NOCAP100
        size, count = wintypes.DWORD(0), wintypes.DWORD(0)
        st = self.pdh.PdhGetFormattedCounterArrayW(h, fmt, byref(size), byref(count), None)
        if st != _PDH_MORE_DATA or size.value == 0:
            return {}
        buf = (ctypes.c_byte * size.value)()
        st = self.pdh.PdhGetFormattedCounterArrayW(h, fmt, byref(size), byref(count), buf)
        if st != 0:
            return {}
        items = ctypes.cast(buf, POINTER(_PDH_FMT_COUNTERVALUE_ITEM_W))
        out: dict[str, float] = {}
        for i in range(count.value):
            it = items[i]
            if it.FmtValue.CStatus in (0, 1):
                out[it.szName] = out.get(it.szName, 0.0) + it.FmtValue.doubleValue
        return out

    def sample(self, own_pids: set[int]) -> dict:
        if not self.ok:
            return {}
        if self.pdh.PdhCollectQueryData(self.query) != 0:
            return {}
        res: dict = {"adapters": {}}
        # --- GPU engines -> per adapter utilisation, total and "ours"
        engines: dict[tuple[str, str], float] = {}
        ours: dict[tuple[str, str], float] = {}
        for inst, val in self._array("gpu_engine").items():
            m = _ENGINE_RE.match(inst)
            if not m:
                continue
            pid, luid, eng, etype = int(m.group(1)), m.group(2).lower(), m.group(3), m.group(4)
            k = (luid, f"{eng}:{etype}")
            engines[k] = engines.get(k, 0.0) + val
            if pid in own_pids:
                ours[k] = ours.get(k, 0.0) + val
        for (luid, eng), val in engines.items():
            a = res["adapters"].setdefault(luid, {"util": 0.0, "ours": 0.0, "engines": {}})
            a["util"] = max(a["util"], min(val, 100.0))
            etype = eng.split(":", 1)[1]
            a["engines"][etype] = max(a["engines"].get(etype, 0.0), min(val, 100.0))
        for (luid, _), val in ours.items():
            a = res["adapters"].setdefault(luid, {"util": 0.0, "ours": 0.0, "engines": {}})
            a["ours"] = max(a["ours"], min(val, 100.0))
        for key, field in (("gpu_dedicated", "dedicated"), ("gpu_shared", "shared")):
            for inst, val in self._array(key).items():
                m = _ADAPTER_RE.match(inst)
                if m:
                    a = res["adapters"].setdefault(m.group(1).lower(), {"util": 0.0, "ours": 0.0, "engines": {}})
                    a[field] = a.get(field, 0) + int(val)
        perf = self._array("cpu_perf")
        freq = self._array("cpu_freq")
        if perf and freq:
            p = next(iter(perf.values()))
            f = next(iter(freq.values()))
            res["cpu_perf_pct"] = p
            res["cpu_base_mhz"] = f
            res["cpu_eff_mhz"] = f * p / 100.0
        return res


# --------------------------------------------------------------------------- NVML
class _NvmlUtil(ctypes.Structure):
    _fields_ = [("gpu", ctypes.c_uint), ("memory", ctypes.c_uint)]


class _NvmlMem(ctypes.Structure):
    _fields_ = [("total", ctypes.c_ulonglong), ("free", ctypes.c_ulonglong), ("used", ctypes.c_ulonglong)]


class Nvml:
    def __init__(self) -> None:
        self.ok = False
        self.handles: list[tuple[str, c_void_p]] = []
        if not IS_WIN:
            return
        try:
            self.lib = ctypes.WinDLL("nvml.dll")
        except OSError:
            return
        try:
            if self.lib.nvmlInit_v2() != 0:
                return
            n = ctypes.c_uint(0)
            self.lib.nvmlDeviceGetCount_v2(byref(n))
            for i in range(n.value):
                h = c_void_p()
                if self.lib.nvmlDeviceGetHandleByIndex_v2(i, byref(h)) != 0:
                    continue
                buf = ctypes.create_string_buffer(96)
                self.lib.nvmlDeviceGetName(h, buf, 96)
                self.handles.append((buf.value.decode(errors="replace"), h))
            self.ok = bool(self.handles)
        except (OSError, AttributeError):
            self.ok = False

    def sample(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        if not self.ok:
            return out
        for name, h in self.handles:
            d: dict = {}
            u, m, t, p, c = _NvmlUtil(), _NvmlMem(), ctypes.c_uint(), ctypes.c_uint(), ctypes.c_uint()
            if self.lib.nvmlDeviceGetUtilizationRates(h, byref(u)) == 0:
                d["util"] = float(u.gpu)
            if self.lib.nvmlDeviceGetMemoryInfo(h, byref(m)) == 0:
                d["mem_used"], d["mem_total"] = int(m.used), int(m.total)
            if self.lib.nvmlDeviceGetTemperature(h, 0, byref(t)) == 0:
                d["temp_c"] = int(t.value)
            if self.lib.nvmlDeviceGetPowerUsage(h, byref(p)) == 0:
                d["power_w"] = p.value / 1000.0
            if self.lib.nvmlDeviceGetClockInfo(h, 0, byref(c)) == 0:
                d["clock_mhz"] = int(c.value)
            out[name] = d
        return out
