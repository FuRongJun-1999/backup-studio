import type { CapabilityRow } from '../../shared/types';

const interfaces = ['USB 桥接', 'SATA', 'NVMe'];
export const capabilityMatrix: CapabilityRow[] = ['Windows', 'Linux', 'macOS'].flatMap((platform) =>
  interfaces.flatMap((bus) => ['NTFS', 'ext4', 'exFAT', 'APFS', 'FAT32', '加密容器', 'VHD', '压缩包内文件系统'].map((filesystem): CapabilityRow => {
    const container = ['加密容器', 'VHD', '压缩包内文件系统'].includes(filesystem);
    const native = ({ Windows: ['NTFS', 'exFAT', 'FAT32'], Linux: ['ext4', 'exFAT', 'FAT32'], macOS: ['APFS', 'exFAT', 'FAT32'] } as Record<string, string[]>)[platform].includes(filesystem);
    return { platform, interface: bus, filesystem,
      detection: container || !native ? '不支持' : platform === 'Windows' ? '可检测' : '仅告警',
      backupSet: native ? '可自动处理' : '不支持',
      directRepair: '不支持',
    };
  })),
);
