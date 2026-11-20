@echo off
rem Opens the ports Lattice uses, on PRIVATE networks only. Run once per laptop, as administrator.
rem   TCP 7470-7499 : dashboard/peer API (7470), metered RPC gate (7480) and spare node slots
rem   UDP 7471      : LAN discovery beacons
net session >nul 2>&1
if errorlevel 1 (
  echo Please right-click allow-firewall.bat and choose "Run as administrator".
  pause
  exit /b 1
)
netsh advfirewall firewall delete rule name="Lattice (TCP)" >nul 2>&1
netsh advfirewall firewall delete rule name="Lattice discovery (UDP)" >nul 2>&1
netsh advfirewall firewall add rule name="Lattice (TCP)" dir=in action=allow protocol=TCP localport=7470-7499 profile=private
netsh advfirewall firewall add rule name="Lattice discovery (UDP)" dir=in action=allow protocol=UDP localport=7471 profile=private
echo.
echo Done. Other laptops can now reach Lattice on PRIVATE networks.
echo If your Wi-Fi is marked "Public", switch it: Settings ^> Network ^& Internet ^> Wi-Fi ^> (your network) ^> Private.
echo To undo: netsh advfirewall firewall delete rule name="Lattice (TCP)"  and  name="Lattice discovery (UDP)"
pause
