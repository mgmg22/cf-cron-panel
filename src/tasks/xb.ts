/// XB 线报推送任务（线报0818）：
/// 抓取 0818tuan 列表页 → 标题黑白名单过滤 → KV(path_id) 去重 → 抓详情页正文/图片
/// → AI（OpenAI 兼容接口）评分筛选 → 钉钉机器人推 markdown。
/// 与签到任务无耦合，由面板调度（见 scheduler.ts / tasks/registry.ts）；HTML 解析用 Workers 内置 HTMLRewriter，无第三方依赖。
///
/// 过滤规则：词表均为子串匹配。标题须命中白名单词且不含任何黑名单词；
/// 详情页正文只再用 commonBlackList 检查一次。改词表时注意白名单词不要包含黑名单词。

import type { CheckinResult, Env } from "../types";
import { notifyDingding } from "../lib/notify";
import { kvReadJson, kvWriteJson } from "../lib/kv";

const SITE = "http://www.0818tuan.com";
const LIST_URL = `${SITE}/list-1-0.html`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const AI_MODEL = "gemini-3-flash-preview";
const KV_SEEN_KEY = "xb_seen"; // KV 键：已处理线报的 path_id 数组（推送成功，或无需推送时写入）
const SEEN_KEEP = 5000; // 去重集合上限，防 KV 值无限膨胀
const MAX_DETAILS = 30; // 详情页抓取上限（免费版单次 50 子请求：1 列表 + N 详情 + 2 AI + 1 钉钉 + 4 KV：去重读写、任务配置读、运行结果写）

// ---- 词表 ----

const cxkWhiteList = [
  "中国银行", "中行", "农业银行", "农行", "交通银行", "交行", "浦发", "邮储", "邮政", "光大", "兴业",
  "平安", "浙商", "杭州银行", "北京银行", "宁波银行",
];

const whiteWordList = [
  "云闪付", "ysf", "xyk", "性用卡", "还款", "工商银行", "工商", "工行", "工银", "e生活", "建设银行", "建行", "建融",
  "招商银行", "招行", "掌上生活", "体验金", "中信", "动卡空间",
  "手淘", "天猫", "猫超", "支付宝", "zfb", "转账", "某付宝", "微信", "wx", "vx", "v.x", "小程序", "立减金", "ljj",
  "公众号", "原文", "推文", "京东", "狗东", "jd", "京豆", "e卡", "美团", "elm",
  "水", "必中", "红包", "虹包", "抽奖", "秒到", "保底", "游戏", "下载", "话费", "移动", "和包", "电信", "q币",
  "扣币", "麦当劳", "肯德基", "必胜客", "星巴克", "瑞幸", "朴朴", "喜茶", "礼品卡", "星礼卡", "深圳通", "网上国网",
  "国补",
];

const xykNameList = ["xing/用卡", "信用卡", "xing用卡", "信用k", "心用卡", "性用卡", "xyk", "信y卡", "深圳"];

const commonBlackList = [
  "定位", "部分", "东北", "徽", "限深圳", "重庆", "深圳地区", "山东", "福建", "江苏", "云南", "江西",
  "河北", "广东", "吉林", "湖北", "河南", "陕西", "湖南", "四川", "宁夏", "广西", "辽宁", "甘肃", "内蒙古",
  "青海", "贵州", "山西", "新疆",
  "厦门", "南京", "东莞", "广州", "南海", "苏州", "中山", "常州", "青岛", "成都", "武汉", "合肥", "揭阳", "无锡",
  "济南", "大连", "石家庄", "泉州", "丹东", "茂名", "长沙", "泰州", "郑州", "惠州", "威海", "绍兴", "哈尔滨", "贵阳",
  "万事达", "visa", "车主", "刷卡达标", "北分", "陆金所", "缤纷生活", "浦大喜奔", "邮储联名", "美团联名", "闪光卡",
  "联名卡", "邮政数币", "农行刷卡金", "农行数币", "会员返现", "兴业生活", "农信", "颜卡",
  "交通银行数币", "交行数币", "交通数币", "光大麦当劳", "阳光惠生活", "光大石化", "广发", "恒丰", "汇丰", "农商",
  "苏银", "善融", "百信", "宝石山", "众邦", "兴农通", "黑卡",
  "特邀", "受邀", "瘦腰", "收腰", "临期", "值得买",
  "vip.iqiyi.com", "出门靠朋友", "深i工", "今天多少", "55618", "【888】",
  "么", "问题", "问问", "问下", "谢谢", "请问", "问一下", "别问", "请教", "求", "咋", "怎样", "咨询", "赐教",
  "啥", "有问", "行不", "何解", "不行", "原因", "帮忙看", "哪来的", "都多少", "是多少", "是不是", "有谁", "大佬",
  "果熟", "有果", "油果", "彦祖", "亦菲", "多不", "谁有", "有没", "如何", "预算", "你们都", "几号", "到底",
  "多少出", "哥哥们",
  "华为", "huawei", "荣耀手机", "mipay", "果子", "苹果", "iphone", "airpods", "pm", "亚瑟", "大疆", "数据", "k70",
  "內衣", "拖鞋", "洞洞鞋", "购物袋", "布袋", "婴", "童装", "小孩", "孩子", "辣妈", "无线", "牙膏", "拉拉裤",
  "伞", "锅", "电动车", "盔", "清风", "纸", "维达", "杯", "椅", "菌", "石头", "奥妙", "家政", "冈本", "南极人",
  "巾", "染", "一次性", "蚊香", "容声", "沐浴", "力士",
  "风险", "美元", "提额", "保险", "开通", "境外", "秒批", "下卡", "开户", "贷", "征信", "费率", "pos", "人脸",
  "审批", "黄牛", "客服", "天天基金", "东方财富",
];

const highBlackList = [
  "【顶】", "需要邀请", "助力", "人团", "拼团", "调研", "申请x", "互助", "攒能量", "组队", "组团", "首单", "盲盒",
  "月黑风高", "互换", "入会", "买1送1", "买一送一", "蒸蒸日上", "淘宝秒杀", "必免", "膨胀",
  "00g", "件", "/袋", "/盒", "/斤", "箱", "罐", "xl", "货", "瓶", "降", "9.9", "如有", "折合", "到手",
  "买家", "小法庭", "单号", "预售", "话术", "拆单", "查询", "高佣", "想买", "尾款", "小黄鱼", "放量", "dy商城",
  "二手", "出售",
  "限量", "健康", "地道", "进口", "真诚", "厉害", "有点6", "骚", "不要脸", "蛋疼", "奇怪", "大事", "谱", "恶心",
  "太乱", "太贵", "真的", "好玩",
  "呢", "呀!", "吧？", "啦", "！", "了。。", "了吧", "了啊", "啊~", "。。。",
  "卧槽", "逼", "牛b", "还好", "根本", "有点东西", "感觉", "居然", "感谢", "心态", "无语", "毛线", "怨", "真是",
  "无耻", "便宜啊", "麻烦", "不如不", "狗了", "差了", "终于", "太次了", "不想搞", "只有", "不服", "见过", "竟然",
  "太难", "看到", "发财", "咱", "口感", "妥妥", "死活", "就这", "狗屁", "感受", "没想到", "兄弟们", "后悔", "吐槽",
  "不能", "删了", "续费", "限制使用", "冻结", "被盗", "差评", "监控", "套牢", "猫饼", "怀疑", "不知道", "黑心",
  "没有", "想法", "网友", "公司", "挤", "上科技", "不友好", "骗", "返买", "反买", "关闭", "闲谈", "投诉", "虚假",
  "进群",
  "被封", "禁", "修复", "盾", "砍", "赔", "秒退", "限额", "吧里", "赖", "水贴", "吐了", "真的假的", "妹", "聊",
  "惨", "起诉", "粪", "女生", "感冒",
  "以后", "即将", "过期", "长期出", "逾期", "防身", "前10", "前年", "收到短信", "上个月", "改规则", "几秒",
  "忘记", "想起", "明天", "变了", "删除", "最近", "上次", "可是", "老",
  "黄了", "没了", "下线", "凉了", "领不了", "领完", "我才", "没抢到", "没到", "未到账", "不到账", "凉凉",
  "抢不到", "上限", "退款", "不给", "砍单", "抢光", "不可用", "审核", "捡漏", "领不到",
  "翻车", "失败", "崩溃", "崩了", "黑号", "号黑", "拦截", "卸载", "火爆", "销户", "垃圾", "风控", "不玩了", "来电",
  "高德", "工行码", "吧码", "迅雷", "电子书", "车险", "模板", "etc",
  "没水", "的水", "漏水", "纯水", "碱水", "水果", "水雾", "吸水", "精萃水", "精华水", "净水", "补水", "花露水",
  "热水", "玻璃水", "口水", "缩水", "水龙", "水润", "水牛", "水枪", "香水", "水壶", "水蜜", "沥水", "水乳",
  "卸妆水", "防水", "饮水", "水泡", "水感", "水饺", "水杨", "水器", "水卫",
  "签到红包", "返红包", "返虹包", "游戏私服", "游戏账号", "朋友圈", "转网", "cm", "ml",
];

const lowBlackList = [
  "多拍", "券包", "免单", "预售", "试用", "点秒杀", "以旧换新", "小程序下单", "直播间下单", "折券", "津贴",
  "三只松鼠", "百草味", "海底捞", "认养一头牛", "火锅", "烧烤", "麻辣烫", "馋", "卤", "炖", "火腿", "爪", "蛋白",
  "豆浆", "维生素", "麦片", "飞鹤", "粥", "面", "小麦", "米线", "粉", "粮", "裙带菜", "蒜", "阿胶", "巧克力",
  "糖", "蛋挞",
  "巧乐兹", "梦龙", "可生食", "羊肉", "虾", "粽", "笋", "大闸蟹", "海参", "榴莲", "梨", "柠檬", "香菇", "鲜花",
  "莓", "玫瑰", "酸菜", "雪糕", "冰淇淋", "柿", "脐橙", "瓜",
  "饮料", "果汁", "百岁山", "农夫", "矿泉水", "茅台", "酒", "窖", "特仑苏", "椰子", "茶叶", "观音", "奶茶",
  "coco", "奈雪", "蜜雪", "茶百道", "古茗", "库迪", "口服",
  "美妆", "珀莱雅", "雅诗兰黛", "毛戈平", "潘婷", "屈臣氏", "大宝", "金纺", "立白", "科颜氏", "林清轩", "欧莱雅",
  "苏菲", "蔻", "洗", "眉", "唇", "泥", "日抛", "护理", "采销", "卫生", "敏感肌", "保湿", "美白", "防晒", "精粹",
  "海蓝", "口罩", "olay", "薇", "美瞳",
  "佛", "机油", "宠物", "翡翠", "轮胎", "图书", "小家电",
  "第三方", "京造", "京东买药", "严选", "喵满分", "李佳琦", "工厂", "宇辉",
  "火车", "电影", "门票", "打车", "顺风车", "养车", "流量", "gb", "出行优惠券", "网盘", "地铁", "网易云", "机票",
  "别墅", "顺丰", "快递", "充电", "民宿", "芒果", "年卡", "腾讯视频", "体检",
  "沪上阿姨", "永和大王", "沃尔玛", "永辉", "盒马", "联华", "costa", "桌游", "米其林", "奥特莱斯", "试驾",
  "plus", "yzf", "翼支付", "svip", "联通", "移动套餐", "美团圈圈", "王卡", "钻石会员", "铂金", "黑金", "腾讯vip",
  "聚惠出行", "凡科",
];

const allBlackTitleList = [...new Set([...commonBlackList, ...highBlackList, ...lowBlackList])];

export function hasWhiteBankName(content: string): boolean {
  return cxkWhiteList.some((sub) => content.includes(sub));
}

export function hasWhiteWord(content: string): boolean {
  return whiteWordList.some((sub) => content.includes(sub));
}

export function hasBlackXykName(content: string): boolean {
  return xykNameList.some((sub) => content.includes(sub)) && hasWhiteBankName(content);
}

// ---- 抓取与解析 ----

interface ListItem {
  href: string;
  text: string;
}

/** 列表页：抓 #redtag 下所有 a.list-group-item 的 href + 文本。 */
async function fetchListItems(): Promise<ListItem[]> {
  let res: Response;
  try {
    res = await fetch(LIST_URL, { headers: { "user-agent": UA } });
    if (!res.ok || !res.body) {
      console.warn(`[xb] 列表页 HTTP ${res.status}`);
      return [];
    }
  } catch (e) {
    // CF 边缘访问 http:// 站点可能被重置，抓取失败返回空列表（不裸抛，避免无信息 500）
    console.warn("[xb] 列表页抓取失败:", e instanceof Error ? e.message : e);
    return [];
  }
  const items: ListItem[] = [];
  const rewriter = new HTMLRewriter().on("#redtag a.list-group-item", {
    element(el) {
      items.push({ href: el.getAttribute("href") || "", text: "" });
    },
    text(t) {
      const last = items[items.length - 1];
      if (last) last.text += t.text;
    },
  });
  await rewriter.transform(new Response(res.body)).arrayBuffer();
  console.log(`[xb] 列表解析 ${items.length} 条，样例: ${items[0]?.href} | ${(items[0]?.text || "").trim().slice(0, 40)}`);
  return items;
}

interface DetailResult {
  raw: string; // 所选节点原文，供黑名单检查
  text: string; // 完整内容：<br>→\n、http 链接转 markdown
  imgs: string[]; // 所选节点内图片 src 列表
}

/** 详情页解析：定位 #xbcontent，取首个 <p>（无 p 则整个 div）内的文本/链接/图片。
 *  HTMLRewriter 无 DOM 树，用 inDiv / inFirstP / curA 标记跟踪嵌套关系（元素与文本按文档序触发）。 */
async function parseDetailHtml(html: string): Promise<DetailResult | null> {
  const st = {
    found: false,
    inDiv: false,
    hasP: false,
    inFirstP: false,
    divText: "",
    pText: "",
    curA: null as { href: string; text: string } | null,
    pLinks: [] as { href: string; text: string }[],
    divLinks: [] as { href: string; text: string }[],
    pImgs: [] as string[],
    divImgs: [] as string[],
  };
  const rewriter = new HTMLRewriter()
    .on("#xbcontent", {
      element(el) {
        st.found = true;
        st.inDiv = true;
        el.onEndTag(() => {
          st.inDiv = false;
        });
      },
      text(t) {
        if (st.inDiv) st.divText += t.text;
      },
    })
    .on("#xbcontent p", {
      element(el) {
        if (st.hasP) return; // 只取文档序第一个 p
        st.hasP = true;
        st.inFirstP = true;
        el.onEndTag(() => {
          st.inFirstP = false;
        });
      },
      text(t) {
        if (st.inFirstP) st.pText += t.text;
      },
    })
    .on("#xbcontent br", {
      element() {
        if (st.inFirstP) st.pText += "\n";
        else if (st.inDiv) st.divText += "\n";
      },
    })
    .on("#xbcontent a", {
      element(el) {
        if (!st.inDiv) return;
        const entry = { href: el.getAttribute("href") || "", text: "" };
        (st.inFirstP ? st.pLinks : st.divLinks).push(entry);
        st.curA = entry;
        el.onEndTag(() => {
          st.curA = null;
        });
      },
      text(t) {
        if (st.curA) st.curA.text += t.text;
      },
    })
    .on("#xbcontent img", {
      element(el) {
        if (!st.inDiv) return;
        (st.inFirstP ? st.pImgs : st.divImgs).push(el.getAttribute("src") || "");
      },
    });
  // transform 需读完流才触发全部 handler
  await rewriter.transform(new Response(html)).arrayBuffer();

  if (!st.found) return null;
  const useP = st.hasP; // 有 p 取首个 p，否则整个 div
  const raw = useP ? st.pText : st.divText;
  const links = useP ? st.pLinks : st.divLinks;
  const imgs = useP ? st.pImgs : st.divImgs;
  return { raw, text: completeContent(raw, links), imgs };
}

async function fetchDetail(href: string): Promise<DetailResult | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(href, { headers: { "user-agent": UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    const html = await res.text();
    return parseDetailHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---- AI 评分 ----

export function cleanJsonResponse(resp: string): string {
  const start = resp.indexOf("[");
  const end = resp.lastIndexOf("]") + 1;
  if (start !== -1 && end > start) {
    const js = resp.slice(start, end);
    try {
      JSON.parse(js);
      return js;
    } catch {
      /* 落回原文 */
    }
  }
  return resp;
}

/** OpenAI 兼容接口评分筛选；两次失败时返回原列表（不筛选）。 */
async function aiAnalyze(env: Env, items: XbItem[]): Promise<XbItem[]> {
  const prompt = `请分析以下内容的价值，并返回符合预期的内容。

输出要求：
1. 必须返回标准的 JSON 数组
2. 不要返回任何其他内容（如 \`\`\`json 标记）
3. 每个对象必须包含以下字段：title, href, src_list, text, score
4. score 字段格式为：「评分1-5分」一句话简要总结的理由

示例输出格式：
[
    {
        "title": "示例标题",
        "href": "示例链接",
        "src_list": ["图片链接1", "图片链接2"],
        "text": "示例文本内容",
        "score": "4分」优惠力度大，活动简单"
    }
]

筛选规则：
符合预期的内容包括：
1. 羊毛活动
2. 优惠活动
3. 红包或现金活动
4. 虚拟卡券
5. 便宜商品
6. 京东活动
7. 这些银行的无地区限制活动(
仅限借记卡["中国银行","中行","农业银行","交通银行","浦发","邮储","邮政","光大","兴业","平安","浙商","杭州银行","北京银行", "宁波银行"],
借记卡和信用卡[工商银行 工行 工银 e生活 建设银行 建融 招商银行 掌上生活 中信])
8. 带有二维码的图片
9. 浙江地区的活动

不符合预期的内容包括：
1. 闲聊,水贴
2. 吐槽
3. 美妆个护商品
4. 女装商品
5. 限定这些地区的活动（深圳、北京、重庆）注意"上海交通卡"是全国通用的活动
6. 提问或求助帖(买什么 买那个)
7. 部分银行信用卡活动["中国银行","农业银行","交通银行","浦发", "邮储", "邮政", "光大", "兴业","平安", "浙商","杭州银行","北京银行","宁波银行"]
8. 这些银行的数字人民币活动("农业银行","交通银行","浦发","邮储","邮政","光大","兴业","平安","浙商","杭州银行","北京银行", "宁波银行" 工商银行 招商银行 中信)

处理要求：
1. 不符合预期的内容不要返回
2. 自动纠正title中的错别字或字母缩写（如 zfb->支付宝, vx->微信, dy->抖音）
3. 保持原有数据结构，仅在 score 字段中添加评分和理由

待分析内容：
${JSON.stringify(items)}`;

  if (!env.API_URL || !env.API_KEY) {
    console.warn("[xb] 未配置 API_URL / API_KEY，跳过 AI 筛选，按原列表推送");
    return items;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(env.API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.API_KEY}` },
        body: JSON.stringify({ model: AI_MODEL, messages: [{ role: "user", content: prompt }] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} - ${(await res.text()).slice(0, 200)}`);
      const data: any = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error(`API响应格式错误：${JSON.stringify(data).slice(0, 200)}`);
      const parsed: unknown = JSON.parse(cleanJsonResponse(content));
      if (!Array.isArray(parsed)) throw new Error("AI 返回非 JSON 数组");
      return parsed as XbItem[];
    } catch (e: any) {
      console.warn(`[xb] AI 第 ${attempt} 次调用失败：${e?.message || e}`);
    }
  }
  return items;
}

// ---- 主流程 ----

interface XbItem {
  title: string;
  path: number;
  href: string;
  text: string;
  src_list: string[];
  score: string;
}

/** 组装所选节点的最终文本：http 链接文本替换为 markdown 链接。 */
export function completeContent(raw: string, links: { href: string; text: string }[]): string {
  let text = raw;
  for (const l of links) {
    if (l.href && /http[s]?:\/\/\S+/.test(l.text)) {
      text = text.replace(l.text, `[${l.href}](${l.href})`);
    }
  }
  return text.trim();
}

/** 读取去重集合。读取失败（含 JSON 损坏）返回 error，调用方须放弃本轮：
 *  否则会把已推送过的线报当成新线报重推，并在写回时覆盖整份历史。 */
async function readSeen(env: Env): Promise<{ seen: Set<number>; error: string }> {
  const r = await kvReadJson<number[]>(env.CHECKIN_STATE, KV_SEEN_KEY);
  return { seen: new Set(Array.isArray(r.value) ? r.value : []), error: r.error };
}

async function writeSeen(env: Env, seen: Set<number>, added: number[]): Promise<void> {
  if (!env.CHECKIN_STATE || !added.length) return;
  const merged = [...seen, ...added];
  const trimmed = merged.length > SEEN_KEEP ? merged.slice(merged.length - SEEN_KEEP) : merged;
  const err = await kvWriteJson(env.CHECKIN_STATE, KV_SEEN_KEY, trimmed);
  // 写失败不阻断推送：宁可下次重复，也不丢线报
  if (err) console.warn("[xb] 去重集合写入 KV 失败:", err);
}

/** dry=true 时（面板「试运行」）：不写去重集合、不推钉钉，把 markdown 原文返回。 */
export async function run(env: Env, opts?: { dry?: boolean }): Promise<CheckinResult> {
  const list = await fetchListItems();
  if (!list.length) {
    return { flag: "STATUS_ERR", content: "⚠️ 列表页解析为空（页面结构可能变化）" };
  }

  const { seen, error: seenError } = await readSeen(env);
  if (seenError) {
    return { flag: "STATUS_ERR", content: `⚠️ 读取去重集合失败，本轮跳过以免重复推送并覆盖历史：${seenError}` };
  }
  const xbList: XbItem[] = [];
  const newlySeen: number[] = [];
  let details = 0;

  for (const item of list) {
    // 标题过滤
    const rawTitle = item.text.trim();
    const title = rawTitle.toLowerCase(); // 仅用于过滤匹配，展示保留原标题
    if (title.endsWith("？") || title.endsWith("?")) continue;
    if (item.href.startsWith("http")) continue;
    if (item.href.includes("618.html") || item.href.includes("pdd/zudui.php")) continue;
    const href = SITE + item.href;
    const m = href.match(/\/xbhd\/(\d+)\.html/);
    if (!m) continue;
    const pathId = parseInt(m[1], 10);
    if (hasBlackXykName(title)) {
      console.log(`[xb] ----无该行信用卡，已忽略\t\t${href}`);
      continue;
    }
    if (allBlackTitleList.some((sub) => title.includes(sub))) continue;
    if (!hasWhiteWord(title) && !hasWhiteBankName(title)) continue;
    if (seen.has(pathId)) {
      console.log(`[xb] 重复已忽略\t\t${href}`);
      continue;
    }
    if (details >= MAX_DETAILS) {
      console.log(`[xb] 达到详情页抓取上限 ${MAX_DETAILS}，本次跳过：${href}`);
      continue;
    }

    // 详情页抓取
    details++;
    const detail = await fetchDetail(href);
    if (!detail) {
      console.log(`[xb] 获取不到帖子内容\t\t${href}`);
      continue;
    }
    const badWord = commonBlackList.find((sub) => detail.raw.includes(sub));
    if (badWord) {
      console.log(`[xb] ${badWord}\t\t----关键字不合法，已忽略\t\t${href}`);
      continue;
    }
    console.log(`[xb] ${title}\t\t${href}`);
    xbList.push({
      title: rawTitle,
      path: pathId,
      href,
      text: detail.text,
      src_list: detail.imgs,
      score: "",
    });
    newlySeen.push(pathId);
  }

  // 去重集合落库时机：推送成功后才落（推送失败则下轮重试，不丢线报）；
  // 无新线报或 AI 筛空时无需推送，直接落，避免下轮重复抓详情页和调 AI；dry 模式不落
  const persistSeen = async () => {
    if (!opts?.dry) await writeSeen(env, seen, newlySeen);
  };
  if (!xbList.length) {
    await persistSeen();
    return { flag: "ALREADY_TODAY", content: "ℹ️ 暂无线报！！" };
  }

  const scored = await aiAnalyze(env, xbList);
  if (!scored.length) {
    await persistSeen();
    return { flag: "ALREADY_TODAY", content: `ℹ️ 本轮线报 ${xbList.length} 条，AI 筛选后无内容，未推送` };
  }
  let markdown = "";
  for (const it of scored) {
    markdown += `\n##### 📌[${it.title}🌟${it.score}](${it.href})\n${it.text}\n`;
    for (const img of it.src_list || []) markdown += `![](${img})`;
  }

  if (opts?.dry) {
    return {
      flag: "SUCCESS",
      content: `[dry] 本轮线报 ${xbList.length} 条，AI 筛选后 ${scored.length} 条\n${markdown.slice(0, 3000)}`,
    };
  }

  const summary = scored[0]?.title || "线报0818";
  const sent = await notifyDingding(summary, markdown, env.XB_BOT_TOKEN, env.XB_BOT_TOKEN_SECRET);
  if (!sent) {
    // 不落去重集合：下一轮会重新抓取并重试推送
    return { flag: "FAIL", content: `⚠️ 本轮线报 ${xbList.length} 条，钉钉推送失败，未记录去重，下轮将重试` };
  }
  await persistSeen();

  return { flag: "SUCCESS", content: `✅ 本轮线报 ${xbList.length} 条，AI 筛选后推送 ${scored.length} 条` };
}
