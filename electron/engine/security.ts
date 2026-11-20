import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

export type ReadOperation = 'volume' | 'dirty' | 'admin' | 'reliability';
export type ReadExecutor = (op: ReadOperation, volume?: string) => Promise<string>;
const exec = promisify(execFile);

export function driveLetter(root: string): string | undefined {
  // Reject namespace paths, ADS and UNC; never turn arbitrary renderer input into a device.
  return /^[a-z]:[\\/](?!.*[:\x00-\x1f])/i.test(root) ? root[0].toUpperCase() : undefined;
}

export function rawWindowsDevice(kind: 'disk' | 'volume', id: number | string): string {
  if (kind === 'volume' && typeof id === 'string' && /^[A-Z]$/.test(id)) return `\\\\.\\${id}:`;
  if (kind === 'disk' && typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 && id <= 65535) {
    return `\\\\.\\PhysicalDrive${id}`;
  }
  throw new Error('无效的设备路径');
}

export function readCommand(op: ReadOperation, volume?: string): { program: string; args: string[] } {
  if (op !== 'admin' && (typeof volume !== 'string' || !/^[A-Z]$/.test(volume))) throw new Error('无效的卷标识');
  if (op === 'dirty') return { program: 'fsutil.exe', args: ['dirty', 'query', `${volume}:`] };
  const scripts = {
    admin: '[int]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    volume: `$v=Get-Volume -DriveLetter '${volume}'; $p=Get-Partition -DriveLetter '${volume}' -ErrorAction SilentlyContinue; $d=if($p){Get-Disk -Number $p.DiskNumber -ErrorAction SilentlyContinue}; $w=Get-CimInstance Win32_Volume -Filter "DriveLetter='${volume}:'" -ErrorAction SilentlyContinue; @{fileSystem=$v.FileSystem; volumeHealth=[string]$v.HealthStatus; volumeStatus=@($v.OperationalStatus | ForEach-Object {[string]$_}); volumeCodes=@($v.CimInstanceProperties['OperationalStatus'].Value); dirty=$w.DirtyBitSet; diskNumber=$d.Number; bus=[string]$d.BusType; partition=[string]$d.PartitionStyle; sector=$d.LogicalSectorSize; bytes=$d.Size; partitionOffset=$p.Offset; partitionBytes=$p.Size; diskStatus=[string]$d.OperationalStatus; offline=$d.IsOffline; readOnly=$d.IsReadOnly; identity=$d.UniqueId} | ConvertTo-Json -Compress`,
    reliability: `$p=Get-Partition -DriveLetter '${volume}'; $d=Get-Disk -Number $p.DiskNumber; $r=Get-StorageReliabilityCounter -Disk $d; @{identity=$d.UniqueId; readErrors=$r.ReadErrorsUncorrected; writeErrors=$r.WriteErrorsUncorrected; temperature=$r.Temperature; wear=$r.Wear} | ConvertTo-Json -Compress`,
  };
  if (!Object.prototype.hasOwnProperty.call(scripts, op)) throw new Error('命令不在只读白名单');
  return { program: 'WindowsPowerShell/v1.0/powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${scripts[op]}`] };
}

export const executeRead: ReadExecutor = async (op, volume) => {
  if (process.platform !== 'win32') throw new Error('平台不支持该只读命令');
  const cmd = readCommand(op, volume);
  // Electron's bundled Node treats SystemRoot as the OS installation root. Never search PATH.
  const root = process.env.SystemRoot;
  if (!root || !/^[a-z]:\\[\w .\\-]+$/i.test(root) || root.includes('..')) throw new Error('无法定位 Windows 系统工具');
  const result = await exec(path.win32.join(root, 'System32', cmd.program), cmd.args, {
    shell: false, windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024,
  });
  return result.stdout.trim();
};

export async function hasDiskPermission(platform = process.platform, run = executeRead): Promise<boolean> {
  if (platform !== 'win32') return process.getuid?.() === 0;
  return (await run('admin').catch(() => '')) === '1';
}

/** 不保存工具原始输出；旧日志中的常见凭据与路径也经过清理。 */
export function redactLog(text: string, redactPaths = true, knownPaths: string[] = []): string {
  let clean = text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[密钥已脱敏]')
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, '$1[已脱敏]')
    .replace(/(["']?\b(?:password|passphrase|token|secret|api[_-]?key|private[_-]?key|密钥|密码)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[已脱敏]');
  if (!redactPaths) return clean;
  for (const root of [...knownPaths].sort((a, b) => b.length - a.length)) {
    if (root) clean = clean.split(root).join('[路径]');
  }
  return clean.replace(/["'](?:[a-z]:[\\/]|\\\\|\/)[^"'\r\n]*["']|(?:[a-z]:[\\/]|\\\\|\/(?!\/))[^\s,;，；"'<>]+/gi, '[路径]');
}
