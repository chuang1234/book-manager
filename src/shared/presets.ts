/**
 * 预置分类与常用标签的清单。
 *
 * 纯数据、零依赖：主进程拿它写库，冒烟与渲染层验证脚本直接引用同一份，
 * 免得测试里再抄一遍名字、改了一处忘了另一处。
 */

/** 一级分类带一句用途说明（编辑分类时才看得到，用于以后判断一本书该放哪儿） */
export interface PresetCategory {
  name: string
  remark?: string
  children: string[]
}

export const PRESET_CATEGORIES: PresetCategory[] = [
  {
    name: '文学',
    remark: '小说、散文、诗歌等虚构与半虚构作品',
    children: ['小说', '散文随笔', '诗歌', '戏剧', '文学评论'],
  },
  {
    name: '历史',
    remark: '通史、断代史、专门史与人物传记',
    children: ['中国史', '世界史', '人物传记', '考古文物'],
  },
  {
    name: '哲学·思想',
    remark: '哲学、宗教与思想史',
    children: ['中国哲学', '西方哲学', '宗教', '伦理学'],
  },
  {
    name: '社会科学',
    remark: '经济、政治、社会、心理与教育',
    children: ['经济金融', '政治法律', '社会学', '心理学', '教育'],
  },
  {
    name: '自然科学',
    remark: '数理化生、天文地理与科普',
    children: ['数学', '物理化学', '生物医学', '天文地理', '科普'],
  },
  {
    name: '计算机',
    remark: '编程、工程、算法与 AI',
    children: ['编程语言', '软件工程', '数据与算法', '人工智能', '运维与网络'],
  },
  {
    name: '艺术·生活',
    remark: '音乐、设计、影像与生活方式',
    children: ['音乐', '美术设计', '摄影影视', '旅行', '饮食家居'],
  },
  {
    name: '古籍·国学',
    remark: '经史子集与传统典籍整理本',
    children: ['经部', '史部', '子部', '集部'],
  },
  {
    name: '工具书',
    remark: '辞典、教材与常备手册',
    children: ['辞典', '教材考试', '手册指南'],
  },
]

/**
 * 常用标签（扁平、可多选，跟分类是横切关系）。
 * 刻意避开「已读／在读」这类词——那是 read_status 字段的事，重复一套只会让人不知道该用哪个。
 */
export const PRESET_TAGS: string[] = [
  '必读',
  '经典',
  '珍藏',
  '绝版',
  '签名本',
  '精读',
  '随时查',
  '待整理',
  '短篇集',
  '大部头',
  '多版本',
  '有笔记',
  '赠书',
  '重读',
]

/** 预设分类的节点总数（一级 + 子级） */
export const PRESET_CATEGORY_COUNT = PRESET_CATEGORIES.reduce((n, c) => n + 1 + c.children.length, 0)
