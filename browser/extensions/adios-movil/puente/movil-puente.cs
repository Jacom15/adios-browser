// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Puente de AdiOS Móvil.
//
// AdiOS lo arranca (api/parent.js) con "--token <secreto>" al abrir el panel Móvil.
// Escucha solo en 127.0.0.1, en un puerto libre que escribe por la salida estándar
// ("PUERTO <n>"), y solo acepta al panel si trae el secreto (ws://127.0.0.1:<n>/?t=<secreto>)
// y viene de una extensión (Origin moz-extension://). Habla con el Android mediante adb y
// scrcpy-server (distribution/scrcpy/) y reenvía el protocolo de scrcpy tal cual: el vídeo
// al panel y los mensajes de control del panel al móvil.
// Se cierra solo cuando AdiOS se cierra (su entrada estándar llega al final) y apaga adb,
// para que las actualizaciones puedan sustituir los archivos de distribution/scrcpy/.
//
// Sin "--token" funciona como en el prototipo: puerto fijo 27184 y sin secreto.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

static class Puente
{
    const int PuertoPrototipo = 27184;
    const string VersionServidor = "5.0.1";
    internal static string adb;
    static string servidor, registro, secreto;
    static readonly object cerrojoRegistro = new object();
    static readonly object cerrojoSesion = new object();
    static Sesion actual;

    internal static void Log(string m)
    {
        lock (cerrojoRegistro)
        {
            try { File.AppendAllText(registro, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "  " + m + Environment.NewLine); }
            catch { }
        }
    }

    static int Main(string[] args)
    {
        string carpeta = AppDomain.CurrentDomain.BaseDirectory;
        adb = Path.Combine(carpeta, "scrcpy", "adb.exe");
        servidor = Path.Combine(carpeta, "scrcpy", "scrcpy-server");
        registro = Path.Combine(Path.GetTempPath(), "adios-movil-puente.log");
        for (int i = 0; i + 1 < args.Length; i++)
        {
            if (args[i] == "--token") secreto = args[i + 1];
        }

        TcpListener escucha;
        try
        {
            escucha = new TcpListener(IPAddress.Loopback, secreto != null ? 0 : PuertoPrototipo);
            escucha.Start();
        }
        catch (SocketException)
        {
            return 0; // Prototipo: ya hay un puente en marcha.
        }
        int puerto = ((IPEndPoint)escucha.LocalEndpoint).Port;
        Log("Puente en marcha en 127.0.0.1:" + puerto + (secreto != null ? " (lanzado por AdiOS)" : ""));

        if (secreto != null)
        {
            Console.Out.WriteLine("PUERTO " + puerto);
            Console.Out.Flush();
            Thread vigia = new Thread(VigilarAdiOS);
            vigia.IsBackground = true;
            vigia.Start();
        }

        while (true)
        {
            TcpClient cliente = escucha.AcceptTcpClient();
            Thread hilo = new Thread(() => Atender(cliente));
            hilo.IsBackground = true;
            hilo.Start();
        }
    }

    // AdiOS mantiene abierta nuestra entrada estándar; cuando se cierra, salimos.
    static void VigilarAdiOS()
    {
        try
        {
            Stream entrada = Console.OpenStandardInput();
            byte[] b = new byte[64];
            while (entrada.Read(b, 0, b.Length) > 0) { }
        }
        catch { }
        Log("AdiOS se ha cerrado; se cierra el puente");
        lock (cerrojoSesion)
        {
            if (actual != null) actual.Parar("AdiOS se ha cerrado");
        }
        Sesion.Adb("kill-server");
        Environment.Exit(0);
    }

    static void Atender(TcpClient cliente)
    {
        try
        {
            NetworkStream red = cliente.GetStream();
            string peticion;
            Dictionary<string, string> cab = LeerCabeceras(red, out peticion);
            string clave, origen;
            cab.TryGetValue("sec-websocket-key", out clave);
            cab.TryGetValue("origin", out origen);
            bool secretoOk = secreto == null || (peticion != null && peticion.StartsWith("GET /?t=" + secreto + " ", StringComparison.Ordinal));
            if (clave == null || origen == null || !origen.StartsWith("moz-extension://", StringComparison.Ordinal) || !secretoOk)
            {
                byte[] no = Encoding.ASCII.GetBytes("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                red.Write(no, 0, no.Length);
                Log("Conexión rechazada (origen: " + (origen ?? "ninguno") + ")");
                cliente.Close();
                return;
            }
            string acepta;
            using (SHA1 sha = SHA1.Create())
            {
                acepta = Convert.ToBase64String(sha.ComputeHash(Encoding.ASCII.GetBytes(clave + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
            }
            byte[] ok = Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acepta + "\r\n\r\n");
            red.Write(ok, 0, ok.Length);
            Sesion s = new Sesion(cliente, red, servidor, VersionServidor);
            lock (cerrojoSesion)
            {
                if (actual != null) actual.Parar("el panel se ha vuelto a conectar");
                actual = s;
            }
            s.Ejecutar();
        }
        catch (Exception e)
        {
            Log("Error atendiendo al panel: " + e.Message);
            try { cliente.Close(); } catch { }
        }
    }

    static Dictionary<string, string> LeerCabeceras(Stream s, out string peticion)
    {
        StringBuilder sb = new StringBuilder();
        int b;
        while ((b = s.ReadByte()) != -1)
        {
            sb.Append((char)b);
            if (sb.Length > 8192) throw new IOException("Cabeceras demasiado largas");
            int n = sb.Length;
            if (n >= 4 && sb[n - 4] == '\r' && sb[n - 3] == '\n' && sb[n - 2] == '\r' && sb[n - 1] == '\n') break;
        }
        string[] lineas = sb.ToString().Split(new[] { "\r\n" }, StringSplitOptions.RemoveEmptyEntries);
        peticion = lineas.Length > 0 ? lineas[0] : null;
        Dictionary<string, string> d = new Dictionary<string, string>();
        foreach (string linea in lineas)
        {
            int i = linea.IndexOf(':');
            if (i > 0) d[linea.Substring(0, i).Trim().ToLowerInvariant()] = linea.Substring(i + 1).Trim();
        }
        return d;
    }
}

class Sesion
{
    readonly TcpClient cliente;
    readonly NetworkStream red;
    readonly string servidor, version;
    readonly object cerrojoEnvio = new object();
    TcpClient video, control;
    Process proceso;
    string serie, puerto;
    int parada;

    public Sesion(TcpClient cliente, NetworkStream red, string servidor, string version)
    {
        this.cliente = cliente; this.red = red; this.servidor = servidor; this.version = version;
    }

    bool Parado { get { return Thread.VolatileRead(ref parada) != 0; } }

    public void Ejecutar()
    {
        try
        {
            Texto("estado:conectando");
            serie = BuscarMovil();
            if (serie == null) return;
            string scid = new Random().Next(1, 0x7FFFFFFF).ToString("x8");
            Adb("-s " + serie + " push \"" + servidor + "\" /data/local/tmp/scrcpy-server.jar");
            puerto = Adb("-s " + serie + " forward tcp:0 localabstract:scrcpy_" + scid).Trim();
            int p;
            if (!int.TryParse(puerto, out p))
            {
                Puente.Log("adb forward no ha dado un puerto: " + puerto);
                puerto = null;
                Texto("error:servidor");
                return;
            }
            ProcessStartInfo psi = new ProcessStartInfo(Puente.adb, "-s " + serie +
                " shell CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server " + version +
                " scid=" + scid + " log_level=info audio=false max_size=1024 video_bit_rate=6000000" +
                " tunnel_forward=true stay_awake=true clipboard_autosync=false");
            psi.UseShellExecute = false; psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
            proceso = Process.Start(psi);
            proceso.OutputDataReceived += (o, e) => { if (e.Data != null) Puente.Log("[móvil] " + e.Data); };
            proceso.ErrorDataReceived += (o, e) => { if (e.Data != null) Puente.Log("[móvil] " + e.Data); };
            proceso.BeginOutputReadLine();
            proceso.BeginErrorReadLine();

            video = Conectar(p, true);
            if (video == null) { Texto("error:servidor"); return; }
            control = Conectar(p, false);
            if (control == null) { Texto("error:servidor"); return; }
            Texto("estado:listo");
            Puente.Log("Sesión iniciada con " + serie + " (scid " + scid + ")");

            Thread hv = new Thread(PasarVideo); hv.IsBackground = true; hv.Start();
            Thread hc = new Thread(VaciarControl); hc.IsBackground = true; hc.Start();
            LeerPanel();
        }
        catch (Exception e)
        {
            if (!Parado) Puente.Log("Sesión: " + e.Message);
        }
        finally
        {
            Parar("fin de la sesión");
        }
    }

    string BuscarMovil()
    {
        bool sinPermiso = false;
        foreach (string l in Adb("devices").Split('\n'))
        {
            string[] partes = l.Trim().Split('\t');
            if (partes.Length < 2) continue;
            if (partes[1] == "device") return partes[0];
            if (partes[1] == "unauthorized") sinPermiso = true;
        }
        Texto(sinPermiso ? "error:sin-permiso" : "error:sin-movil");
        return null;
    }

    internal static string Adb(string args)
    {
        ProcessStartInfo psi = new ProcessStartInfo(Puente.adb, args);
        psi.UseShellExecute = false; psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
        try
        {
            using (Process pr = Process.Start(psi))
            {
                Task<string> err = pr.StandardError.ReadToEndAsync();
                string o = pr.StandardOutput.ReadToEnd();
                pr.WaitForExit();
                if (pr.ExitCode != 0) Puente.Log("adb " + args + " -> " + pr.ExitCode + ": " + err.Result.Trim());
                return o;
            }
        }
        catch (Exception e)
        {
            Puente.Log("No se puede ejecutar adb: " + e.Message);
            return "";
        }
    }

    TcpClient Conectar(int p, bool esperarByte)
    {
        for (int i = 0; i < 100 && !Parado; i++)
        {
            TcpClient t = new TcpClient();
            try
            {
                t.NoDelay = true;
                t.Connect(IPAddress.Loopback, p);
                if (!esperarByte) return t;
                t.ReceiveTimeout = 2000;
                if (t.GetStream().ReadByte() != -1)
                {
                    t.ReceiveTimeout = 0;
                    return t;
                }
            }
            catch (IOException) { }
            catch (SocketException) { }
            t.Close();
            Thread.Sleep(100);
        }
        return null;
    }

    void PasarVideo()
    {
        byte[] b = new byte[1 << 16];
        try
        {
            NetworkStream s = video.GetStream();
            int n;
            while (!Parado && (n = s.Read(b, 0, b.Length)) > 0) Enviar(0x2, b, n);
        }
        catch (Exception e)
        {
            if (!Parado) Puente.Log("Vídeo: " + e.Message);
        }
        Parar("el vídeo se ha cerrado");
    }

    void VaciarControl()
    {
        byte[] b = new byte[4096];
        try
        {
            NetworkStream s = control.GetStream();
            while (!Parado && s.Read(b, 0, b.Length) > 0) { }
        }
        catch { }
    }

    void LeerPanel()
    {
        NetworkStream c = control.GetStream();
        while (!Parado)
        {
            int b0 = red.ReadByte(); if (b0 == -1) return;
            int b1 = red.ReadByte(); if (b1 == -1) return;
            int op = b0 & 0x0F;
            long len = b1 & 0x7F;
            if (len == 126) { byte[] l = Leer(2); len = (l[0] << 8) | l[1]; }
            else if (len == 127) { byte[] l = Leer(8); len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | l[i]; }
            if (len > (1 << 20)) return;
            byte[] mascara = (b1 & 0x80) != 0 ? Leer(4) : null;
            byte[] datos = Leer((int)len);
            if (mascara != null) for (int i = 0; i < datos.Length; i++) datos[i] ^= mascara[i % 4];
            if (op == 0x8) return;
            if (op == 0x9) { Enviar(0xA, datos, datos.Length); continue; }
            if (op == 0x2 && datos.Length > 0) c.Write(datos, 0, datos.Length);
        }
    }

    byte[] Leer(int n)
    {
        byte[] r = new byte[n];
        int o = 0;
        while (o < n)
        {
            int k = red.Read(r, o, n - o);
            if (k <= 0) throw new IOException("el panel se ha cerrado");
            o += k;
        }
        return r;
    }

    void Enviar(int op, byte[] d, int n)
    {
        lock (cerrojoEnvio)
        {
            byte[] h;
            if (n < 126) h = new byte[] { (byte)(0x80 | op), (byte)n };
            else if (n < 65536) h = new byte[] { (byte)(0x80 | op), 126, (byte)(n >> 8), (byte)n };
            else
            {
                h = new byte[10];
                h[0] = (byte)(0x80 | op); h[1] = 127;
                for (int i = 0; i < 8; i++) h[9 - i] = (byte)(((long)n) >> (8 * i));
            }
            red.Write(h, 0, h.Length);
            red.Write(d, 0, n);
        }
    }

    void Texto(string t)
    {
        byte[] d = Encoding.UTF8.GetBytes(t);
        Enviar(0x1, d, d.Length);
    }

    public void Parar(string motivo)
    {
        if (Interlocked.Exchange(ref parada, 1) != 0) return;
        Puente.Log("Sesión parada: " + motivo);
        try { if (video != null) video.Close(); } catch { }
        try { if (control != null) control.Close(); } catch { }
        try { if (proceso != null && !proceso.HasExited) proceso.Kill(); } catch { }
        try { cliente.Close(); } catch { }
        if (serie != null && puerto != null) Adb("-s " + serie + " forward --remove tcp:" + puerto);
    }
}
