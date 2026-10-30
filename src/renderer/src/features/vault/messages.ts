// Strings of the data folder screen (VaultSetup).

import { createMessages } from '../../i18n';

const en = {
  setupTitle: 'Choose a data folder',
  setupDesc:
    'Tape keeps your watchlists, price alerts and notifications in a folder you choose, one subfolder per IB account. Copy the folder to back it up, or keep it in a synced folder (iCloud Drive, Dropbox …) to use it on another computer.',
  setupHint: 'Choose an empty folder to start a new one, or a Tape data folder from another computer.',
  goneTitle: 'Data folder not available',
  goneDesc:
    'It was moved, deleted, or its drive is not connected. Tape cannot be used until it is back or another folder is chosen; nothing is saved meanwhile.',
  newerTitle: 'Data folder from a newer Tape',
  newerDesc: 'This folder was written by a newer version of Tape. Update Tape, or choose another folder.',
  choose: 'Choose folder…',
  chooseOther: 'Choose another folder…',
  retry: 'Try again',
  stillGone: 'The folder is still not available',
};

const zh: typeof en = {
  setupTitle: '选择数据目录',
  setupDesc: 'Tape 把自选列表、价格提醒和通知保存在你选择的文件夹里，每个 IB 账户一个子文件夹。复制这个文件夹即可备份；放在同步文件夹（iCloud 云盘、Dropbox 等）里，就能在另一台电脑上使用。',
  setupHint: '选择空文件夹会新建数据目录；也可以选择另一台电脑上的 Tape 数据目录。',
  goneTitle: '数据目录不可用',
  goneDesc: '它被移动、删除，或所在的硬盘未连接。在它恢复或选择其他文件夹之前，Tape 无法使用，期间不会保存任何数据。',
  newerTitle: '数据目录来自更新版本的 Tape',
  newerDesc: '这个文件夹由更新版本的 Tape 写入。请更新 Tape，或选择其他文件夹。',
  choose: '选择文件夹…',
  chooseOther: '选择其他文件夹…',
  retry: '重试',
  stillGone: '这个文件夹仍不可用',
};

export const useVaultMessages = createMessages({ en, zh });
