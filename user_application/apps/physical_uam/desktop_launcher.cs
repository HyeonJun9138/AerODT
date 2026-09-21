using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading.Tasks;
using System.Windows.Forms;

// Thin Windows entry point: the console and native runtime stay beside this EXE.
class PhysicalLauncher {
    [STAThread]
    static void Main() {
        Application.EnableVisualStyles();
        var splash=new Form {Text="AerODT Physical",Width=380,Height=150,StartPosition=FormStartPosition.CenterScreen,FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false};
        var label=new Label {Text="Physical 콘솔을 준비하고 있습니다…",Dock=DockStyle.Fill,TextAlign=System.Drawing.ContentAlignment.MiddleCenter};
        splash.Controls.Add(label);
        splash.Shown+=async delegate {
            try { await Task.Run((Action)Start); splash.Close(); }
            catch(Exception e) {MessageBox.Show(splash,e.Message,"AerODT Physical",MessageBoxButtons.OK,MessageBoxIcon.Warning);splash.Close();}
        };
        Application.Run(splash);
    }
    static void Start() {
        string root=AppDomain.CurrentDomain.BaseDirectory;
        string script=Path.Combine(root,"Start-UAM-Physical.ps1");
        if(!File.Exists(script)||!Directory.Exists(Path.Combine(root,"physical_uam")))throw new Exception("실행 파일을 Start-UAM-Physical.ps1 및 physical_uam 폴더와 같은 위치에 두세요.");
        var info=new ProcessStartInfo("powershell.exe","-NoProfile -File \""+script+"\" -NoBrowser -Idle") {UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=root};
        using(var p=Process.Start(info)) {
            if(!p.WaitForExit(20000))throw new Exception("서버 시작 확인 시간이 초과되었습니다. 잠시 후 다시 실행해 주세요.");
            if(p.ExitCode!=0)throw new Exception("송신 서버 시작 실패. Start-UAM-Physical.ps1 또는 publisher.err.log에서 원인을 확인해 주세요.");
        }
        bool ready=false;
        for(int i=0;i<40;i++) {
            try {using(var web=new WebClient()){string data=web.DownloadString("http://127.0.0.1:8770/api/v1/status");ready=data.Contains("console_version");}}catch(WebException){}
            if(ready)break;System.Threading.Thread.Sleep(250);
        }
        if(!ready)throw new Exception("Physical 콘솔이 응답하지 않습니다. publisher.err.log를 확인하거나 기존 송신 서버를 종료한 뒤 다시 실행하세요.");
        string[] browsers={Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"Google/Chrome/Application/chrome.exe"),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),"Microsoft/Edge/Application/msedge.exe"),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Google/Chrome/Application/chrome.exe")};
        foreach(string browser in browsers)if(File.Exists(browser)){Process.Start(new ProcessStartInfo(browser,"--app=http://127.0.0.1:8770/ --window-size=1180,900"){UseShellExecute=true});return;}
        Process.Start(new ProcessStartInfo("http://127.0.0.1:8770/"){UseShellExecute=true});
    }
}
