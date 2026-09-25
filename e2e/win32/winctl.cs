// Tiny Win32 helper for Keel's end-to-end tests on Windows: finds windows, reads their
// position, z-order and topmost state, checks the foreground window, and sends real mouse and
// keyboard input. Compiled on the test machine with the .NET Framework's csc.exe.
//
//   winctl find <title-regex>          first visible top-level window whose title matches
//   winctl rect <hwnd>                 visible bounds: x y width height
//   winctl foreground                  hwnd of the foreground window
//   winctl activate <hwnd>             bring a window to the foreground (like a user click)
//   winctl topmost <hwnd>              1 if the window is always-on-top
//   winctl zorder                      visible top-level windows, topmost first
//   winctl workarea                    x y width height of the primary work area
//   winctl click <x> <y>               left click at screen coordinates
//   winctl drag <x1> <y1> <x2> <y2>    press, move in steps, release
//   winctl move <hwnd> <x> <y>         move without resizing or activating
//   winctl keys ctrl+alt+shift+f       press a key combination
//   winctl title <hwnd>                window title
//   winctl screenshot <file.png>       capture the whole virtual screen
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

static class WinCtl
{
    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint p, out RECT r, uint win);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    static List<IntPtr> TopLevel()
    {
        var list = new List<IntPtr>();
        EnumWindows((h, l) => { if (IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
        return list; // EnumWindows walks top-level windows in z-order, top first
    }

    static string Title(IntPtr h)
    {
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static RECT Bounds(IntPtr h)
    {
        RECT r;
        // Visible bounds (excludes the invisible resize borders and shadow).
        if (DwmGetWindowAttribute(h, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out r, Marshal.SizeOf(typeof(RECT))) != 0)
            GetWindowRect(h, out r);
        return r;
    }

    static void Click(int x, int y)
    {
        SetCursorPos(x, y);
        Thread.Sleep(60);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); // LEFTDOWN
        Thread.Sleep(40);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); // LEFTUP
    }

    static byte Vk(string k)
    {
        switch (k)
        {
            case "ctrl": case "control": return 0x11;
            case "alt": return 0x12;
            case "shift": return 0x10;
            case "win": case "super": return 0x5B;
            case "space": return 0x20;
            case "escape": case "esc": return 0x1B;
            case "enter": return 0x0D;
            case "tab": return 0x09;
        }
        if (k.Length == 1) return (byte)char.ToUpperInvariant(k[0]);
        if (k.StartsWith("f") && k.Length <= 3) return (byte)(0x6F + int.Parse(k.Substring(1)));
        throw new ArgumentException("unknown key " + k);
    }

    static int Main(string[] a)
    {
        SetProcessDPIAware();
        try
        {
            switch (a[0])
            {
                case "find":
                    var re = new Regex(a[1]);
                    foreach (var h in TopLevel()) if (re.IsMatch(Title(h))) { Console.WriteLine(h.ToInt64()); return 0; }
                    return 1;
                case "title":
                    Console.WriteLine(Title(new IntPtr(long.Parse(a[1])))); return 0;
                case "rect":
                    {
                        var r = Bounds(new IntPtr(long.Parse(a[1])));
                        Console.WriteLine("{0} {1} {2} {3}", r.L, r.T, r.R - r.L, r.B - r.T); return 0;
                    }
                case "foreground":
                    Console.WriteLine(GetForegroundWindow().ToInt64()); return 0;
                case "activate":
                    {
                        var h = new IntPtr(long.Parse(a[1]));
                        uint target = GetWindowThreadProcessId(h, IntPtr.Zero);
                        uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
                        uint me = GetCurrentThreadId();
                        // A tap of Alt plus attaching input lets a test tool move the foreground,
                        // as a user click would.
                        keybd_event(0x12, 0, 0, UIntPtr.Zero);
                        keybd_event(0x12, 0, 2, UIntPtr.Zero);
                        AttachThreadInput(me, fg, true);
                        AttachThreadInput(me, target, true);
                        ShowWindow(h, 5);
                        BringWindowToTop(h);
                        SetForegroundWindow(h);
                        AttachThreadInput(me, target, false);
                        AttachThreadInput(me, fg, false);
                        return 0;
                    }
                case "topmost":
                    Console.WriteLine((GetWindowLong(new IntPtr(long.Parse(a[1])), -20) & 0x8) != 0 ? 1 : 0); return 0;
                case "zorder":
                    foreach (var h in TopLevel()) Console.WriteLine(h.ToInt64());
                    return 0;
                case "workarea":
                    {
                        RECT r; SystemParametersInfo(0x0030, 0, out r, 0);
                        Console.WriteLine("{0} {1} {2} {3}", r.L, r.T, r.R - r.L, r.B - r.T); return 0;
                    }
                case "click":
                    Click(int.Parse(a[1]), int.Parse(a[2])); return 0;
                case "drag":
                    {
                        int x1 = int.Parse(a[1]), y1 = int.Parse(a[2]), x2 = int.Parse(a[3]), y2 = int.Parse(a[4]);
                        SetCursorPos(x1, y1); Thread.Sleep(80);
                        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
                        Thread.Sleep(120);
                        for (int i = 1; i <= 15; i++) { SetCursorPos(x1 + (x2 - x1) * i / 15, y1 + (y2 - y1) * i / 15); Thread.Sleep(30); }
                        Thread.Sleep(100);
                        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
                        return 0;
                    }
                case "move":
                    SetWindowPos(new IntPtr(long.Parse(a[1])), IntPtr.Zero, int.Parse(a[2]), int.Parse(a[3]), 0, 0, 0x0001 | 0x0004 | 0x0010);
                    return 0;
                case "keys":
                    {
                        var keys = a[1].ToLowerInvariant().Split('+');
                        foreach (var k in keys) { keybd_event(Vk(k), 0, 0, UIntPtr.Zero); Thread.Sleep(20); }
                        for (int i = keys.Length - 1; i >= 0; i--) { keybd_event(Vk(keys[i]), 0, 2, UIntPtr.Zero); Thread.Sleep(20); }
                        return 0;
                    }
                case "screenshot":
                    {
                        int x = GetSystemMetrics(76), y = GetSystemMetrics(77), w = GetSystemMetrics(78), h = GetSystemMetrics(79);
                        using (var bmp = new Bitmap(w, h))
                        {
                            using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(x, y, 0, 0, bmp.Size);
                            bmp.Save(a[1], ImageFormat.Png);
                        }
                        return 0;
                    }
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message);
            return 2;
        }
        Console.Error.WriteLine("unknown command");
        return 2;
    }
}
