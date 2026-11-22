import { button, el } from './dom';
import { createOverlay } from './overlay';

const QUICK_RULES: Array<{ mark: string; title: string; copy: string }> = [
  { mark: '邻', title: '打接壤', copy: '目标需与己方任意领地接壤。' },
  { mark: '拖', title: '按住拖', copy: '按住蓄力，拖向目标，松手出兵。' },
  { mark: '升', title: '三路升级', copy: '产兵、行军、城防；炮台自动炮击。' },
];

const RULES: Array<{ title: string; body: string }> = [
  {
    title: '目标需与己方接壤',
    body: '目标只需与任意一块己方领地相连；可从任意己方领地派兵，不必与目标直接相连。与所有己方领地都断开的孤立目标不可派兵。',
  },
  {
    title: '按住越久，派得越多',
    body: '在己方领地上按住：起步 20%，0.5 秒约 60%，按住 1 秒到 100%。100% 指可调动兵力，系统会保留安全驻军。',
  },
  {
    title: '拖动即锁定',
    body: '拖动超过 10 像素后比例锁定。松手在空白处、红色目标或多指操作时取消，不扣兵。',
  },
  {
    title: '产兵与容量',
    body: '己方领地每秒自动产兵，达到容量上限后停止。每块领地的数字牌始终显示“驻军/容量”。中立地受损未失守，休整后补回开局守军。',
  },
  {
    title: '三种升级',
    body: '选中己方领地可用驻军升级：产兵提高产速，行军提高移动速度，城防增加独立城防兵。城防兵不能派出；升级城防只补上限差额，不会自动补满。',
  },
  {
    title: '城墙与炮台',
    body: '城防 Lv1 建城墙，Lv2 加装加农炮。炮台自动炮击射程内经过的敌军，并短暂冷却。',
  },
  {
    title: '地形与胜负',
    body: '森林、丘陵、山地提高守方防御。倒计时结束比较控地分值、领地数与总兵力；敌方全部消失则立即获胜。',
  },
  {
    title: '州界底图，架空地形',
    body: '地图轮廓来自公开州界数据，按真实地理比例绘制；地形、通路、河流与桥梁属于架空战场设定。',
  },
];

export function createRulesOverlay(onClose: () => void): HTMLElement {
  const parts = createOverlay('rules-overlay');
  parts.card.setAttribute('role', 'dialog');
  parts.card.setAttribute('aria-modal', 'true');
  parts.card.setAttribute('aria-labelledby', 'rules-title');

  const header = el('header', 'overlay-header');
  const titles = el('div', 'overlay-titles');
  const kicker = el('p', 'overlay-kicker', 'HOW TO PLAY');
  const title = el('h2', 'overlay-title', '玩法说明');
  title.id = 'rules-title';
  titles.appendChild(kicker);
  titles.appendChild(title);
  const close = button('关闭', 'overlay-close', onClose);
  close.setAttribute('aria-label', '关闭玩法说明');
  header.appendChild(titles);
  header.appendChild(close);

  const body = el('div', 'overlay-body rules-body');
  const quick = el('div', 'rules-quick');
  for (let i = 0; i < QUICK_RULES.length; i += 1) {
    const item = el('div', 'rules-quick-item');
    item.appendChild(el('span', 'rules-quick-mark', QUICK_RULES[i].mark));
    item.appendChild(el('p', 'rules-quick-title', QUICK_RULES[i].title));
    item.appendChild(el('p', 'rules-quick-copy', QUICK_RULES[i].copy));
    quick.appendChild(item);
  }
  body.appendChild(quick);

  const more = el('details', 'rules-more');
  const summary = el('summary', 'rules-more-summary', '详细规则');
  more.appendChild(summary);
  const list = el('ol', 'rules-list');
  for (let i = 0; i < RULES.length; i += 1) {
    const item = el('li', 'rules-item');
    item.appendChild(el('span', 'rules-index', '0' + (i + 1)));
    const textWrap = el('div', 'rules-text');
    textWrap.appendChild(el('h3', 'rules-title', RULES[i].title));
    textWrap.appendChild(el('p', 'rules-copy', RULES[i].body));
    item.appendChild(textWrap);
    list.appendChild(item);
  }
  more.appendChild(list);
  body.appendChild(more);

  const footer = el('footer', 'overlay-footer');
  const back = button('明白了', 'btn btn-primary btn-wide', onClose);
  footer.appendChild(back);

  parts.card.appendChild(header);
  parts.card.appendChild(body);
  parts.card.appendChild(footer);
  return parts.root;
}
