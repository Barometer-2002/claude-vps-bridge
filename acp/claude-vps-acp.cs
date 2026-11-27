using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class ClaudeVpsAcpLauncher
{
    private static string QuoteWin32Arg(string arg)
    {
        if (arg == null) return "\"\"";
        if (arg.Length == 0) return "\"\"";
        bool needsQuotes = false;
        foreach (char c in arg)
        {
            if (char.IsWhiteSpace(c) || c == '"')
            {
                needsQuotes = true;
                break;
            }
        }
        if (!needsQuotes) return arg;

        var sb = new StringBuilder();
        sb.Append('"');
        int backslashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\')
            {
                backslashes++;
            }
            else if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
                backslashes = 0;
            }
            else
            {
                if (backslashes > 0)
                {
                    sb.Append('\\', backslashes);
                    backslashes = 0;
                }
                sb.Append(c);
            }
        }
        if (backslashes > 0) sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    private static int GetNodeMajorVersion(string nodeExe)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = "-p \"process.versions.node.split('.')[0]\"",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            using (var proc = Process.Start(psi))
            {
                if (proc == null) return 0;
                string output = proc.StandardOutput.ReadToEnd().Trim();
                proc.WaitForExit(3000);
                int major;
                if (proc.ExitCode == 0 && int.TryParse(output, out major)) return major;
            }
        }
        catch
        {
            // Candidate failed to execute.
        }
        return 0;
    }

    private static string FindNodeOnPath()
    {
        string pathEnv = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrEmpty(pathEnv)) return null;
        foreach (string rawDir in pathEnv.Split(';'))
        {
            string dir = rawDir == null ? "" : rawDir.Trim().Trim('"');
            if (dir.Length == 0) continue;
            try
            {
                string candidate = Path.Combine(dir, "node.exe");
                if (File.Exists(candidate) && GetNodeMajorVersion(candidate) >= 24) return candidate;
            }
            catch
            {
                // Ignore malformed PATH entries.
            }
        }
        return null;
    }

    private static string ResolveNode(string exeDir)
    {
        string fromEnv = Environment.GetEnvironmentVariable("CLAUDE_VPS_NODE");
        if (!string.IsNullOrEmpty(fromEnv) && File.Exists(fromEnv)) return fromEnv;

        if (!string.IsNullOrEmpty(exeDir))
        {
            string pinnedFile = Path.Combine(exeDir, "node-path.txt");
            if (File.Exists(pinnedFile))
            {
                try
                {
                    string pinned = File.ReadAllText(pinnedFile, Encoding.UTF8).Trim();
                    if (!string.IsNullOrEmpty(pinned) && Path.IsPathRooted(pinned) && File.Exists(pinned))
                    {
                        return pinned;
                    }
                }
                catch
                {
                    // Fall through to PATH / Program Files lookup.
                }
            }
        }

        string fromPath = FindNodeOnPath();
        if (!string.IsNullOrEmpty(fromPath)) return fromPath;

        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        if (!string.IsNullOrEmpty(pf))
        {
            string candidate = Path.Combine(pf, "nodejs", "node.exe");
            if (File.Exists(candidate) && GetNodeMajorVersion(candidate) >= 24) return candidate;
        }
        return null;
    }

    public static int Main(string[] args)
    {
        string exeDir = Path.GetDirectoryName(typeof(ClaudeVpsAcpLauncher).Assembly.Location);
        string script = Path.Combine(exeDir, "claude-vps-acp.mjs");
        if (!File.Exists(script))
        {
            Console.Error.WriteLine("Claude VPS ACP script not found: " + script);
            return 1;
        }
        string nodeExe = ResolveNode(exeDir);
        if (string.IsNullOrEmpty(nodeExe))
        {
            Console.Error.WriteLine("Node.js 24+ executable not found. Run node acp/manage-acp.mjs install with Node.js 24+.");
            return 1;
        }

        var argBuilder = new StringBuilder();
        argBuilder.Append(QuoteWin32Arg(script));
        foreach (string a in args)
        {
            argBuilder.Append(' ');
            argBuilder.Append(QuoteWin32Arg(a));
        }

        var psi = new ProcessStartInfo
        {
            FileName = nodeExe,
            Arguments = argBuilder.ToString(),
            UseShellExecute = false,
        };

        using (var proc = Process.Start(psi))
        {
            if (proc == null)
            {
                Console.Error.WriteLine("Failed to start Node.js for Claude VPS ACP.");
                return 1;
            }
            Console.CancelKeyPress += (sender, e) => { e.Cancel = true; };
            proc.WaitForExit();
            return proc.ExitCode;
        }
    }
}
