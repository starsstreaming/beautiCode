#pragma codepage 65001

#define MyAppName "beautiCode"
#define MyAppPublisher "beautiCode"

#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif

#ifndef StageDir
  #error StageDir must point to the packaged Windows release directory.
#endif

#ifndef OutputDir
  #error OutputDir must point to the installer output directory.
#endif

[Setup]
AppId={{690C1A5A-97DB-4D28-B9A6-73F47D7D46F7}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\beautiCode
DefaultGroupName=beautiCode
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
MinVersion=10.0.17763
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=beautiCode-Setup-{#MyAppVersion}-win-x64
SetupIconFile={#StageDir}\beauticode.ico
UninstallDisplayIcon={app}\beauticode.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
AppMutex=Local\beautiCode.Engine.Tray.v1
VersionInfoVersion={#MyAppVersion}.0
VersionInfoProductName={#MyAppName}
VersionInfoDescription=Local backgrounds for DeepSeek Harness
VersionInfoCompany={#MyAppPublisher}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加选项："; Flags: unchecked
Name: "autostart"; Description: "登录 Windows 后自动启动"; GroupDescription: "附加选项："; Flags: unchecked

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\beautiCode"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\scripts\start-beauticode.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\beauticode.ico"
Name: "{autodesktop}\beautiCode"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\scripts\start-beauticode.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\beauticode.ico"; Tasks: desktopicon
Name: "{userstartup}\beautiCode"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\scripts\start-beauticode-engine.ps1"" -NoLaunchCodex"; WorkingDir: "{app}"; IconFilename: "{app}\beauticode.ico"; Tasks: autostart

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\scripts\start-beauticode.ps1"""; WorkingDir: "{app}"; Description: "启动 beautiCode"; Flags: postinstall nowait skipifsilent
