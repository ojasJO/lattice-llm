@echo off
rem Lets other laptops on the same network reach Lattice. Run once per laptop, as administrator.
rem   TCP 7470-7499 : dashboard/peer API (7470), metered RPC gate (7480) and spare node slots
rem   UDP 7471      : LAN discovery beacons
rem Works on Private and Public networks (campus Wi-Fi is usually Public), but only for
rem devices on your own subnet. The dashboard itself still only answers this laptop.
net session >nul 2>&1
if errorlevel 1 (
  echo Please right-click allow-firewall.bat and choose "Run as administrator".
  pause
  exit /b 1
)
netsh advfirewall firewall delete rule name="Lattice (TCP)" >nul 2>&1
netsh advfirewall firewall delete rule name="Lattice discovery (UDP)" >nul 2>&1
netsh advfirewall firewall add rule name="Lattice (TCP)" dir=in action=allow protocol=TCP localport=7470-7499 remoteip=localsubnet profile=private,public
netsh advfirewall firewall add rule name="Lattice discovery (UDP)" dir=in action=allow protocol=UDP localport=7471 remoteip=localsubnet profile=private,public
echo.
echo Done. Laptops on the same network can now reach Lattice. No restart needed.
echo To undo: netsh advfirewall firewall delete rule name="Lattice (TCP)"  and  name="Lattice discovery (UDP)"
pause
