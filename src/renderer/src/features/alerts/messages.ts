// Price alert strings (design "pa" form texts).
import { createMessages } from '../../i18n';

export const useAlertMessages = createMessages({
  en: {
    title: (sym: string) => `Price alert · ${sym}`,
    last: 'Last',
    above: 'Above',
    below: 'Below',
    triggerPrice: 'Trigger price',
    fromLast: (d: string) => `From last ${d}`,
    alreadyMet: ' · already met, fires at once',
    enterPrice: 'Enter a price',
    noLast: 'No live price',
    repeat: 'Repeat',
    repeatDesc: 'Alert every time the price crosses; off = once only',
    cancel: 'Cancel',
    create: 'Create alert',
    added: (desc: string) => `Alert added: ${desc}`,
    saveFailed: (msg: string) => `Could not save the alert: ${msg}`,
  },
  zh: {
    title: (sym: string) => `价格提醒 · ${sym}`,
    last: '现价',
    above: '高于',
    below: '低于',
    triggerPrice: '触发价格',
    fromLast: (d: string) => `距现价 ${d}`,
    alreadyMet: ' · 已满足，会立即触发',
    enterPrice: '请输入价格',
    noLast: '暂无实时价格',
    repeat: '重复触发',
    repeatDesc: '每次穿越该价格都提醒；关闭则只提醒一次',
    cancel: '取消',
    create: '创建提醒',
    added: (desc: string) => `已添加提醒：${desc}`,
    saveFailed: (msg: string) => `无法保存提醒：${msg}`,
  },
});
