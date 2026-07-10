using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

internal static class NativeHostLauncher
{
    private static void Copy(Stream input, Stream output, bool closeOutput)
    {
        try
        {
            var buffer = new byte[32768];
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                output.Write(buffer, 0, read);
                output.Flush();
            }
        }
        catch
        {
            // 管道断开是 Native Messaging 结束时的正常情况。
        }
        finally
        {
            if (closeOutput)
            {
                try { output.Close(); } catch { }
            }
        }
    }

    public static int Main()
    {
        var directory = AppDomain.CurrentDomain.BaseDirectory;
        var logPath = Path.Combine(directory, "launcher.log");
        try
        {
            var config = File.ReadAllLines(Path.Combine(directory, "launcher.config"), Encoding.UTF8);
            if (config.Length < 2) throw new InvalidOperationException("launcher.config 不完整。");
            var startInfo = new ProcessStartInfo
            {
                FileName = config[0],
                Arguments = "\"" + config[1].Replace("\"", "\\\"") + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = directory
            };
            var child = Process.Start(startInfo);
            if (child == null) throw new InvalidOperationException("无法启动 Node.js 宿主。");

            var inputThread = new Thread(() => Copy(Console.OpenStandardInput(), child.StandardInput.BaseStream, true));
            var outputThread = new Thread(() => Copy(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false));
            var errorThread = new Thread(() =>
            {
                try
                {
                    var text = child.StandardError.ReadToEnd();
                    if (!String.IsNullOrWhiteSpace(text)) File.AppendAllText(logPath, text, Encoding.UTF8);
                }
                catch { }
            });
            inputThread.IsBackground = true;
            outputThread.IsBackground = true;
            errorThread.IsBackground = true;
            inputThread.Start();
            outputThread.Start();
            errorThread.Start();
            child.WaitForExit();
            outputThread.Join(2000);
            errorThread.Join(2000);
            return child.ExitCode;
        }
        catch (Exception error)
        {
            try { File.AppendAllText(logPath, DateTime.Now + " " + error + Environment.NewLine, Encoding.UTF8); } catch { }
            return 1;
        }
    }
}
