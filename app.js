/* =========================================================
   Daily One —— 极简多条日记 PWA
   数据（entries.json + 图片）存储在阿里云 OSS
   localStorage 仅作为离线缓存
   ========================================================= */

/* ---------------- OSS 客户端（顶部初始化） ---------------- */
// 仅限个人使用。请在阿里云 RAM 中创建专用子账号，只授予该子账号对目标 Bucket
// dailyone/ 前缀的 oss:PutObject、oss:GetObject 和 oss:DeleteObject 权限，
// 不要授予 ListObjects 或任何 Bucket 管理权限。
// 前端持有 DeleteObject 权限意味着 AK 泄露后可删除该前缀下的所有文件，
// 请务必开启 Bucket 版本控制作为兜底。
const OSS_REGION = 'oss-cn-hangzhou'
const OSS_BUCKET = 'daily-one'

let ossClient = null
try {
  ossClient = new OSS({
    region: OSS_REGION,
    accessKeyId: 'YOUR_RAM_ACCESS_KEY_ID',
    accessKeySecret: 'YOUR_RAM_ACCESS_KEY_SECRET',
    bucket: OSS_BUCKET
  })
} catch (e) {
  // SDK CDN 加载失败（离线首访）时为 null，后续所有 OSS 操作会走失败分支
  ossClient = null
}

/* ---------------- 常量与全局状态 ---------------- */
const ENTRIES_KEY = 'dailyone/entries.json'        // OSS 上日记数据文件
const CACHE_KEY = 'dailyone:entries-cache'         // localStorage 缓存键

// Idea 按钮内置提示语
const IDEAS = [
  '今天最让我开心的一件小事是……',
  '如果用一句话总结今天，我会说……',
  '今天我学到的一件事是……',
  '此刻我最感激的人或事是……',
  '今天有一点小遗憾，它是……',
  '最近反复出现在我脑海里的念头是……',
  '今天遇到的一个有趣的人或瞬间……',
  '如果能重来一次今天，我想改变……',
  '今天身体和情绪的状态如何？',
  '写给一年后的自己一句话……',
  '今天拖延了什么？为什么？',
  '今晚睡前，我希望放下的是……'
]

let entries = []        // 内存中的全部日记
let keyword = ''        // 当前搜索关键词
let pendingImages = []  // 新条目待保存的图片列表 [{ key }]，数量无上限
let uploading = false   // 图片是否上传中
let editingId = null    // 正在编辑的条目 id
let editImages = []     // 编辑中的图片列表 [{ key }]，数量无上限
let initialized = false // 首次 OSS 读取或离线回退完成后才允许保存

/* ---------------- DOM 引用 ---------------- */
const $ = (id) => document.getElementById(id)

const searchInput = $('searchInput')
const syncStatusEl = $('syncStatus')
const syncTextEl = syncStatusEl.querySelector('.sync-text')
const retrySyncBtn = $('retrySyncBtn')
const todaySection = $('todaySection')
const todayDateLabel = $('todayDateLabel')
const todayList = $('todayList')
const emptyToday = $('emptyToday')
const searchSection = $('searchSection')
const searchResults = $('searchResults')
const noResults = $('noResults')
const composer = $('composer')
const newTextarea = $('newTextarea')
const newPreview = $('newPreview')
const imageInput = $('imageInput')
const saveBtn = $('saveBtn')
const ideaBtn = $('ideaBtn')
const uploadingTip = $('uploadingTip')
const overlay = $('overlay')
const overlayImg = $('overlayImg')

/* ---------------- 工具函数 ---------------- */

// 兼容旧数据：单图 imageKey 转为多图 imageKeys 数组
function normalizeEntry(e) {
  if (!Array.isArray(e.imageKeys)) {
    e.imageKeys = e.imageKey ? [e.imageKey] : []
  }
  delete e.imageKey
  return e
}

// 本地时区日期字符串 YYYY-MM-DD（不用 toISOString 截取，避免时区偏移）
function localDateStr(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// HH:mm（本地时区）
function hhmm(iso) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

// 生成 id，优先 crypto.randomUUID
function uuid() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

// HTML 转义（用于搜索高亮前先转义，防 XSS）
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// 拼接 OSS 图片 URL（私有 Bucket 签名 URL），width 为缩放宽度，null 表示原图
// 签名有效期 24 小时：URL 每次渲染时重新生成，已加载的图片不受过期影响
function imageUrl(imageKey, width) {
  if (!ossClient) return ''
  const opts = { expires: 86400 }
  if (width) opts.process = `image/resize,w_${width}`
  return ossClient.signatureUrl(imageKey, opts)
}

/* ---------------- 同步状态管理 ---------------- */

// 显示非阻塞提示（离线 / 同步失败）
function showSyncStatus(message) {
  syncTextEl.textContent = message
  syncStatusEl.hidden = false
}

function clearSyncStatus() {
  syncStatusEl.hidden = true
}

/* ---------------- OSS 操作 ---------------- */

// 上传图片，返回对象 Key
async function uploadImage(file) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
  const objectKey = `dailyone/images/${uuid()}.${ext}`
  await ossClient.put(objectKey, file)
  return objectKey
}

// 删除 OSS 对象
async function deleteObject(objectKey) {
  if (!objectKey) return
  await ossClient.delete(objectKey)
}

// OSS get 返回的 content 兼容转文本（Blob / ArrayBuffer / Buffer / string）
async function ossContentToText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (typeof Blob !== 'undefined' && content instanceof Blob) return await content.text()
  if (typeof ArrayBuffer !== 'undefined' && content instanceof ArrayBuffer) {
    return new TextDecoder().decode(content)
  }
  if (content.arrayBuffer) {
    const ab = await content.arrayBuffer()
    return new TextDecoder().decode(ab)
  }
  return new TextDecoder().decode(content)
}

/* ---------------- 数据读写 ---------------- */

// 从 OSS 读取 entries.json，失败抛错由调用方降级
async function loadEntries() {
  if (!ossClient) throw new Error('OSS 客户端不可用')
  const result = await ossClient.get(ENTRIES_KEY, {
    headers: { 'Cache-Control': 'no-cache' }
  })
  const text = await ossContentToText(result.content)
  const data = JSON.parse(text)
  return Array.isArray(data) ? data : []
}

// 将内存中完整数组上传覆盖 entries.json，成功后刷新缓存
async function syncEntries() {
  const json = JSON.stringify(entries)
  try {
    await ossClient.put(ENTRIES_KEY, new Blob([json], { type: 'application/json' }))
    localStorage.setItem(CACHE_KEY, json)
    clearSyncStatus()
  } catch (e) {
    // 上传失败：数据暂存本地，不阻塞用户继续操作
    localStorage.setItem(CACHE_KEY, json)
    showSyncStatus('同步失败，数据已暂存本地，下次联网后会重试')
    throw e
  }
}

/* ---------------- 渲染 ---------------- */

// 顶层渲染：搜索态 / 今天列表 二选一
function renderAll() {
  if (keyword) {
    todaySection.hidden = true
    composer.hidden = true
    searchSection.hidden = false
    renderSearchResults()
  } else {
    searchSection.hidden = true
    todaySection.hidden = false
    composer.hidden = false
    renderToday()
  }
}

// 渲染"今天"列表，按 createdAt 倒序
function renderToday() {
  const today = localDateStr()
  todayDateLabel.textContent = `今天 · ${today}`
  const list = entries
    .filter((e) => e.date === today)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

  todayList.textContent = ''
  list.forEach((entry) => todayList.appendChild(createEntryCard(entry, null)))
  emptyToday.hidden = list.length > 0
}

// 渲染搜索结果：按 date 倒序分组，组内按 createdAt 倒序
function renderSearchResults() {
  const kw = keyword.toLowerCase()
  const matched = entries.filter((e) => (e.text || '').toLowerCase().includes(kw))

  searchResults.textContent = ''
  noResults.hidden = matched.length > 0

  const dates = [...new Set(matched.map((e) => e.date))].sort().reverse()
  dates.forEach((date) => {
    const group = document.createElement('section')
    group.className = 'search-group'

    const h = document.createElement('h3')
    h.textContent = date
    group.appendChild(h)

    matched
      .filter((e) => e.date === date)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .forEach((entry) => group.appendChild(createEntryCard(entry, keyword)))

    searchResults.appendChild(group)
  })
}

// 构造单条日记卡片；kw 非空表示搜索态（高亮 + 无操作按钮）
function createEntryCard(entry, kw) {
  // 编辑态：原位切换为编辑表单
  if (editingId === entry.id) return createEditCard(entry)

  const card = document.createElement('article')
  card.className = 'entry'

  const time = document.createElement('div')
  time.className = 'entry-time'
  time.textContent = hhmm(entry.createdAt)
  card.appendChild(time)

  const text = document.createElement('p')
  text.className = 'entry-text'
  renderHighlighted(text, entry.text, kw)
  card.appendChild(text)

  if (entry.imageKeys.length) {
    card.appendChild(createThumbGrid(entry.imageKeys, 400, false, null))
  }

  if (!kw) {
    const actions = document.createElement('div')
    actions.className = 'entry-actions'

    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.textContent = '编辑'
    editBtn.addEventListener('click', () => startEdit(entry.id))

    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.textContent = '删除'
    delBtn.addEventListener('click', () => deleteEntry(entry.id))

    actions.appendChild(editBtn)
    actions.appendChild(delBtn)
    card.appendChild(actions)
  }

  return card
}

// 文本写入元素：有关键词时先转义再插 <mark>（防 XSS），否则直接 textContent
function renderHighlighted(el, text, kw) {
  if (!kw) {
    el.textContent = text || ''
    return
  }
  const lower = (text || '').toLowerCase()
  const k = kw.toLowerCase()
  let idx = 0
  let html = ''
  while (idx <= lower.length) {
    const pos = lower.indexOf(k, idx)
    if (pos === -1) {
      html += escapeHtml((text || '').slice(idx))
      break
    }
    html += escapeHtml((text || '').slice(idx, pos))
    html += '<mark>' + escapeHtml((text || '').slice(pos, pos + k.length)) + '</mark>'
    idx = pos + k.length
  }
  el.innerHTML = html
}

// 构造单张缩略图，加载失败静默移除（连同外层容器），点击打开全屏原图
function createThumb(imageKey, width) {
  const img = document.createElement('img')
  img.className = 'thumb'
  img.alt = '日记图片'
  img.loading = 'lazy'
  img.src = imageUrl(imageKey, width)
  img.addEventListener('error', () => {
    const wrap = img.closest('.thumb-item') || img
    wrap.remove()
  })
  img.addEventListener('click', () => openOverlay(imageKey))
  return img
}

// 构造缩略图网格（数量无上限）；allowRemove 为 true 时每张图带移除按钮（编辑态/输入态用）
function createThumbGrid(keys, width, allowRemove, onRemove) {
  const grid = document.createElement('div')
  grid.className = 'thumb-grid'
  keys.forEach((key) => {
    const item = document.createElement('div')
    item.className = 'thumb-item'
    item.appendChild(createThumb(key, width))
    if (allowRemove && onRemove) {
      const rm = document.createElement('button')
      rm.type = 'button'
      rm.className = 'thumb-remove'
      rm.title = '移除图片'
      rm.textContent = '×'
      rm.addEventListener('click', () => onRemove(key))
      item.appendChild(rm)
    }
    grid.appendChild(item)
  })
  return grid
}

/* ---------------- 编辑交互 ---------------- */

// 进入编辑态
function startEdit(id) {
  const entry = entries.find((e) => e.id === id)
  if (!entry) return
  editingId = id
  editImages = entry.imageKeys.map((key) => ({ key }))
  renderAll()
}

// 构造编辑态卡片（原位替换）
function createEditCard(entry) {
  const card = document.createElement('article')
  card.className = 'entry edit-card'

  const ta = document.createElement('textarea')
  ta.rows = 3
  ta.value = entry.text
  card.appendChild(ta)

  // 图片预览区（多图网格，每张带移除按钮）
  const previewWrap = document.createElement('div')
  card.appendChild(previewWrap)

  const refreshPreview = () => {
    previewWrap.textContent = ''
    if (!editImages.length) return
    previewWrap.appendChild(createThumbGrid(
      editImages.map((im) => im.key), 300, true,
      (key) => {
        // 移除单张：从列表去掉该 key，旧图交给生命周期规则清理
        editImages = editImages.filter((im) => im.key !== key)
        refreshPreview()
      }
    ))
  }
  refreshPreview()

  const actions = document.createElement('div')
  actions.className = 'edit-actions'

  // 添加图片：支持一次多选，数量无上限，旧图交给生命周期规则清理
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = 'image/*'
  fileInput.multiple = true
  fileInput.hidden = true
  const addLabel = document.createElement('label')
  addLabel.className = 'file-label'
  const addText = document.createElement('span')
  addText.textContent = '添加图片'
  addLabel.appendChild(addText)
  addLabel.appendChild(fileInput)
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || [])
    fileInput.value = ''
    if (!files.length) return
    addText.textContent = '上传中…'
    try {
      for (const file of files) {
        const key = await uploadImage(file)
        editImages.push({ key })
        refreshPreview()
      }
    } catch (e) {
      showSyncStatus('图片上传失败，请检查网络后重试')
    } finally {
      addText.textContent = '添加图片'
    }
  })
  actions.appendChild(addLabel)

  const saveEditBtn = document.createElement('button')
  saveEditBtn.type = 'button'
  saveEditBtn.className = 'primary'
  saveEditBtn.textContent = '保存修改'
  saveEditBtn.addEventListener('click', () => saveEdit(entry, ta.value))

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'ghost'
  cancelBtn.textContent = '取消'
  cancelBtn.addEventListener('click', () => {
    editingId = null
    editImages = []
    renderAll()
  })

  actions.appendChild(saveEditBtn)
  actions.appendChild(cancelBtn)
  card.appendChild(actions)

  return card
}

// 保存编辑：更新 text / imageKeys / updatedAt，移除的图片不删除（生命周期兜底）
async function saveEdit(entry, newText) {
  const text = (newText || '').trim()
  if (!text) return
  entry.text = text
  entry.imageKeys = editImages.map((im) => im.key)
  entry.updatedAt = new Date().toISOString()
  editingId = null
  editImages = []
  renderAll()
  try {
    await syncEntries()
  } catch (e) {
    // 同步失败已提示并暂存本地，不阻塞
  }
}

/* ---------------- 删除（级联删除图片） ---------------- */
async function deleteEntry(id) {
  const idx = entries.findIndex((e) => e.id === id)
  if (idx === -1) return
  if (!confirm('确定删除这条日记吗？删除后无法恢复。')) return

  const entry = entries[idx]
  const snapshot = entries.slice()

  // 1. 先删除关联的全部图片；失败不阻断删除流程
  let imageCleanFailed = false
  for (const key of entry.imageKeys || []) {
    try {
      await deleteObject(key)
    } catch (e) {
      imageCleanFailed = true
    }
  }

  // 2. 图片删除（或尝试）后，从内存数组移除并同步
  entries.splice(idx, 1)
  try {
    await syncEntries()
    renderAll()
    if (imageCleanFailed) {
      showSyncStatus('日记已删除，但图片清理失败，可在 OSS 控制台手动清理')
    }
  } catch (e) {
    // 3. entries.json 更新失败：回滚内存与缓存，不回滚已删除的图片
    entries = snapshot
    localStorage.setItem(CACHE_KEY, JSON.stringify(entries))
    renderAll()
    showSyncStatus('删除失败，请重试')
  }
}

/* ---------------- 新增条目（底部输入区） ---------------- */

// 更新保存按钮可用状态：文本为空或上传中时禁用
function updateSaveBtn() {
  saveBtn.disabled = !initialized || uploading || !newTextarea.value.trim()
}

// 刷新新条目图片预览（网格，每张带移除按钮）
function refreshNewPreview() {
  newPreview.textContent = ''
  newPreview.hidden = pendingImages.length === 0
  if (!pendingImages.length) return
  newPreview.appendChild(createThumbGrid(
    pendingImages.map((im) => im.key), 300, true,
    (key) => {
      pendingImages = pendingImages.filter((im) => im.key !== key)
      refreshNewPreview()
    }
  ))
}

// 选择图片后立即上传 OSS（支持一次多选，数量无上限）
imageInput.addEventListener('change', async () => {
  const files = Array.from(imageInput.files || [])
  imageInput.value = ''
  if (!files.length || uploading) return

  uploading = true
  uploadingTip.hidden = false
  updateSaveBtn()
  try {
    for (const file of files) {
      const key = await uploadImage(file)
      pendingImages.push({ key })
      refreshNewPreview()
    }
  } catch (e) {
    showSyncStatus('图片上传失败，请检查网络后重试')
  } finally {
    uploading = false
    uploadingTip.hidden = true
    updateSaveBtn()
  }
})

// 保存新条目
async function saveNewEntry() {
  const text = newTextarea.value.trim()
  if (!initialized || !text || uploading) return

  const now = new Date().toISOString()
  entries.push({
    id: uuid(),
    date: localDateStr(),
    text,
    imageKeys: pendingImages.map((im) => im.key),
    createdAt: now,
    updatedAt: now
  })

  // 清空输入区
  newTextarea.value = ''
  pendingImages = []
  refreshNewPreview()
  updateSaveBtn()

  renderAll()
  try {
    await syncEntries()
  } catch (e) {
    // 同步失败已提示并暂存本地，不阻塞
  }
}

saveBtn.addEventListener('click', saveNewEntry)
newTextarea.addEventListener('input', updateSaveBtn)

/* ---------------- Idea 按钮 ---------------- */
ideaBtn.addEventListener('click', () => {
  newTextarea.value = IDEAS[Math.floor(Math.random() * IDEAS.length)]
  updateSaveBtn()
  newTextarea.focus()
})

/* ---------------- 搜索 ---------------- */
searchInput.addEventListener('input', () => {
  keyword = searchInput.value.trim()
  renderAll()
})

/* ---------------- 全屏图片查看 ---------------- */
function openOverlay(imageKey) {
  overlayImg.src = imageUrl(imageKey, null) // 原图，不加处理参数
  overlay.hidden = false
}

function closeOverlay() {
  overlay.hidden = true
  overlayImg.removeAttribute('src')
}

overlay.addEventListener('click', closeOverlay)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !overlay.hidden) closeOverlay()
})

/* ---------------- Service Worker 注册 ---------------- */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // 注册失败静默处理
  })
}

/* ---------------- 同步失败重试 ---------------- */
retrySyncBtn.addEventListener('click', async () => {
  try {
    await syncEntries() // 成功后 clearSyncStatus 会隐藏提示
  } catch (e) {
    // 仍失败则保持提示
  }
})

/* ---------------- 应用启动 ---------------- */
async function init() {
  let loaded = false
  retrySyncBtn.hidden = true
  showSyncStatus('正在从 OSS 加载最新日记…')

  // OSS 优先
  try {
    entries = (await loadEntries()).map(normalizeEntry)
    localStorage.setItem(CACHE_KEY, JSON.stringify(entries))
    loaded = true
    clearSyncStatus()
  } catch (e) {
    loaded = false
  }

  // 降级：localStorage 缓存
  if (!loaded) {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]')
      entries = (Array.isArray(cached) ? cached : []).map(normalizeEntry)
    } catch (e) {
      entries = [] // 缓存解析失败视为空数组，不白屏
    }
    showSyncStatus('当前离线，显示的是缓存数据，修改可能无法同步。')
    retrySyncBtn.hidden = false
  }

  initialized = true
  renderAll()
  updateSaveBtn()
}

init()
