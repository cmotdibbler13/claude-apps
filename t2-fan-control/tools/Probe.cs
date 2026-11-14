// Read-only diagnostic: prints fan and temperature keys.
using System;
using System.Threading;
using T2Fans;

static class Probe
{
    static string Hex(byte[] b) { return b == null ? "(null)" : BitConverter.ToString(b); }

    static void Main(string[] args)
    {
        try
        {
            using (Smc smc = new Smc())
            {
                Console.WriteLine("SMC opened.");
                Console.WriteLine("F0Ac raw info: " + Hex(smc.RawInfo("F0Ac")));
                Console.WriteLine("FNum raw info: " + Hex(smc.RawInfo("FNum")));
                int n = smc.FanCount();
                Console.WriteLine("Fans: " + n);
                for (int i = 0; i < n; i++)
                {
                    foreach (string s in new string[] { "Ac", "Mn", "Mx", "Tg", "Md" })
                    {
                        string k = "F" + i + s;
                        KeyInfo ki = smc.GetInfo(k);
                        Console.WriteLine("  " + k + " type=" + (ki == null ? "?" : "'" + ki.Type + "' len=" + ki.Len) +
                            " value=" + smc.ReadNumber(k) + " raw=" + Hex(smc.ReadBytes(k)));
                    }
                }
                int count = smc.KeyCount();
                Console.WriteLine("Key count: " + count);
                for (int i = 0; i < 4; i++) Console.WriteLine("KeyAt(" + i + ") = " + smc.KeyAt(i) + " rc=" + smc.LastRc);
                if (args.Length > 0 && args[0] == "temps")
                {
                    for (int i = 0; i < count; i++)
                    {
                        string k = smc.KeyAt(i);
                        if (k == null) { Console.WriteLine("  idx " + i + " rc=" + smc.LastRc); continue; }
                        if (k[0] != 'T') continue;
                        KeyInfo ki = smc.GetInfo(k);
                        double v = smc.ReadNumber(k);
                        Console.WriteLine("  " + k + " [" + (ki == null ? "?" : ki.Type) + "] = " + v.ToString("0.0"));
                    }
                }
            }
        }
        catch (Exception ex) { Console.WriteLine("ERROR: " + ex.Message); }
    }
}
