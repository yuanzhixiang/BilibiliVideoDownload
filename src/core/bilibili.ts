import UA from '../assets/data/ua'
import { formatSeconed, filterTitle, sleep } from '../utils'
import { qualityMap, userQuality } from '../assets/data/quality'
import { customAlphabet } from 'nanoid'
import alphabet from '../assets/data/alphabet'
import { VideoData, Page, DownloadUrl, Subtitle, TaskData } from '../type'
import { store, pinia } from '../store'

// 自定义uuid
const nanoid = customAlphabet(alphabet, 16)

/**
 * @params videoInfo: 当前下载的视频详情 selected：所选的分p quality：所选的清晰度
 * @returns 返回下载数据 Array
 */
const getDownloadList = async (videoInfo: VideoData, selected: number[], quality: number) => {
  const downloadList: VideoData[] = []
  console.log('开始获取下载列表', {
    selectedPages: selected,
    quality,
    totalPages: videoInfo.page.length,
    availableQualities: videoInfo.qualityOptions.map(q => q.value)
  })

  for (let index = 0; index < selected.length; index++) {
    const currentPage = selected[index]
    console.log(`处理第 ${index + 1}/${selected.length} 个视频，页码: ${currentPage}`)
    // 请求选中清晰度视频下载地址
    const currentPageData = videoInfo.page.find(item => item.page === currentPage)
    if (!currentPageData) {
      const error = `未找到页码 ${currentPage} 的视频数据`
      console.error(error)
      throw new Error(error)
    }
    const currentCid = currentPageData.cid
    const currentBvid = currentPageData.bvid
    console.log('当前视频信息:', {
      title: currentPageData.title,
      cid: currentCid,
      bvid: currentBvid
    })

    // 获取下载地址
    // 判断当前数据是否有下载地址列表，有则直接用，没有再去请求
    const downloadUrl: DownloadUrl = { video: '', audio: '' }
    const videoUrl = videoInfo.video.find(item => item.id === quality && item.cid === currentCid)
    const audioUrl = getHighQualityAudio(videoInfo.audio)

    if (videoUrl && audioUrl) {
      console.log('使用缓存的下载地址')
      downloadUrl.video = videoUrl.url
      downloadUrl.audio = audioUrl.url
    } else {
      console.log('获取新的下载地址')
      try {
        const { video, audio } = await getDownloadUrl(currentCid, currentBvid, quality)
        downloadUrl.video = video
        downloadUrl.audio = audio
        console.log('获取下载地址成功')
      } catch (error: any) {
        console.error('获取下载地址失败:', error.message)
        throw error
      }
    }
    // 获取字幕地址
    const subtitle = await getSubtitle(currentCid, currentBvid)
    const taskId = nanoid()
    const videoData: VideoData = {
      ...videoInfo,
      id: taskId,
      title: currentPageData.title,
      url: currentPageData.url,
      quality: quality,
      duration: currentPageData.duration,
      createdTime: +new Date(),
      cid: currentCid,
      bvid: currentBvid,
      downloadUrl,
      filePathList: handleFilePathList(selected.length === 1 ? 0 : currentPage, currentPageData.title, videoInfo.up[0].name, currentBvid, taskId),
      fileDir: handleFileDir(selected.length === 1 ? 0 : currentPage, currentPageData.title, videoInfo.up[0].name, currentBvid, taskId),
      subtitle
    }
    downloadList.push(videoData)
    if (index !== selected.length - 1) {
      await sleep(1000)
    }
  }
  return downloadList
}

const addDownload = (videoList: VideoData[] | TaskData[]) => {
  const allowDownloadCount = store.settingStore(pinia).downloadingMaxSize - store.baseStore(pinia).downloadingTaskCount
  const taskList: TaskData[] = []
  if (allowDownloadCount >= 0) {
    videoList.forEach((item, index) => {
      if (index < allowDownloadCount) {
        taskList.push({
          ...item,
          status: 1,
          progress: 0
        })
      } else {
        taskList.push({
          ...item,
          status: 4,
          progress: 0
        })
      }
    })
  }
  return taskList
}

/**
 *
 * @returns 保存cookie中的bfe_id
 */
const saveResponseCookies = (cookies: string[]) => {
  if (cookies && cookies.length) {
    const cookiesString = cookies.join(';')
    console.log('bfe: ', cookiesString)
    store.settingStore(pinia).setBfeId(cookiesString)
  }
}

/**
 *
 * @returns 0: 游客，未登录 1：普通用户 2：大会员
 */
const checkLogin = async (SESSDATA: string) => {
  try {
    const { body } = await window.electron.got('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        'User-Agent': `${UA}`,
        cookie: `SESSDATA=${SESSDATA}`
      },
      responseType: 'json'
    })
    console.log('登录状态检查结果:', {
      isLogin: body.data.isLogin,
      vipStatus: body.data.vipStatus,
      vipType: body.data.vipType,
      uname: body.data.uname
    })
    if (body.data.isLogin && !body.data.vipStatus) {
      return 1
    } else if (body.data.isLogin && body.data.vipStatus) {
      return 2
    } else {
      return 0
    }
  } catch (error: any) {
    console.error('登录状态检查失败:', error.message)
    throw new Error(`登录状态检查失败: ${error.message}`)
  }
}

// 检查url合法
const checkUrl = (url: string) => {
  const mapUrl = {
    'video/av': 'BV',
    'video/BV': 'BV',
    'play/ss': 'ss',
    'play/ep': 'ep'
  }
  let flag = false
  for (const key in mapUrl) {
    if (url.includes(key)) {
      flag = true
      return mapUrl[key]
    }
  }
  if (!flag) {
    return ''
  }
}

// 检查url是否有重定向
const checkUrlRedirect = async (videoUrl: string) => {
  try {
    console.log('检查URL重定向:', videoUrl)
    const params = {
      videoUrl,
      config: {
        headers: {
          'User-Agent': `${UA}`,
          cookie: `SESSDATA=${store.settingStore(pinia).SESSDATA}`
        }
      }
    }
    const { body, redirectUrls } = await window.electron.got(params.videoUrl, params.config)
    const url = redirectUrls[0] ? redirectUrls[0] : videoUrl
    console.log('URL重定向结果:', {
      originalUrl: videoUrl,
      finalUrl: url,
      hasRedirect: !!redirectUrls[0],
      bodyLength: body?.length || 0
    })
    return {
      body,
      url
    }
  } catch (error: any) {
    console.error('URL重定向检查失败:', error.message)
    throw new Error(`URL重定向检查失败: ${error.message}`)
  }
}

const parseHtml = (html: string, type: string, url: string) => {
  switch (type) {
    case 'BV':
      return parseBV(html, url)
    case 'ss':
      return parseSS(html)
    case 'ep':
      return parseEP(html, url)
    default:
      return -1
  }
}

const parseBV = async (html: string, url: string) => {
  try {
    const videoInfo = html.match(/<script>.*?window\.__INITIAL_STATE__=([\s\S]*?);/)
    if (!videoInfo) throw new Error('parse bv error')
    const { videoData } = JSON.parse(videoInfo[1])
    // 获取视频下载地址
    let acceptQuality = null
    try {
      let downLoadData: any = html.match(/\<script\>window\.\_\_playinfo\_\_\=([\s\S]*?)\<\/script\>\<script\>window\.\_\_INITIAL\_STATE\_\_\=/)
      if (!downLoadData) throw new Error('parse bv error')
      downLoadData = JSON.parse(downLoadData[1])
      acceptQuality = {
        accept_quality: downLoadData.data.accept_quality,
        video: downLoadData.data.dash.video,
        audio: downLoadData.data.dash.audio
      }
    } catch (error) {
      acceptQuality = await getAcceptQuality(videoData.cid, videoData.bvid)
    }
    // 检查用户权限和可用清晰度
    const userLevel = await getUserLevel()
    const availableQualities = filterQualitiesByUserLevel(acceptQuality.accept_quality, userLevel)
    console.log(`用户等级: ${userLevel}, 原始清晰度:`, acceptQuality.accept_quality)
    console.log('用户可用清晰度:', availableQualities)

    const obj: VideoData = {
      id: '',
      title: videoData.title,
      url,
      bvid: videoData.bvid,
      cid: videoData.cid,
      cover: videoData.pic,
      createdTime: -1,
      quality: -1,
      view: videoData.stat.view,
      danmaku: videoData.stat.danmaku,
      reply: videoData.stat.reply,
      duration: formatSeconed(videoData.duration),
      up: videoData.hasOwnProperty('staff') ? videoData.staff.map((item: any) => ({ name: item.name, mid: item.mid })) : [{ name: videoData.owner.name, mid: videoData.owner.mid }],
      qualityOptions: availableQualities.map((item: any) => ({ label: qualityMap[item], value: item })),
      page: parseBVPageData(videoData, url),
      subtitle: [],
      video: acceptQuality.video ? acceptQuality.video.map((item: any) => ({ id: item.id, cid: videoData.cid, url: item.baseUrl })) : [],
      audio: acceptQuality.audio ? acceptQuality.audio.map((item: any) => ({ id: item.id, cid: videoData.cid, url: item.baseUrl })) : [],
      filePathList: [],
      fileDir: '',
      size: -1,
      downloadUrl: { video: '', audio: '' }
    }
    console.log('bv')
    console.log(obj)
    return obj
  } catch (error: any) {
    throw new Error(error)
  }
}

const parseEP = async (html: string, url: string) => {
  try {
    console.log('开始解析EP视频:', url)

    // 尝试新的解析方式：解析 __NEXT_DATA__
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
    if (nextDataMatch) {
      console.log('找到__NEXT_DATA__，使用新的解析方式')
      return await parseEPFromNextData(nextDataMatch[1], url)
    }

    // 尝试解析 playurlSSRData
    const playurlDataMatch = html.match(/const playurlSSRData = ([\s\S]*?);/)
    if (playurlDataMatch) {
      console.log('找到playurlSSRData，尝试解析')
      const playurlData = JSON.parse(playurlDataMatch[1])
      console.log('playurlSSRData:', playurlData)
      // 这个数据主要包含播放信息，但缺少基本的视频元数据，需要结合其他方法
    }

    // 先尝试原有的匹配模式（向后兼容）
    let videoInfo = html.match(/\<script\>window\.\_\_INITIAL\_STATE\_\_\=([\s\S]*?)\;\(function\(\)\{var s\;/)

    if (!videoInfo) {
      console.log('原始匹配模式失败，尝试其他匹配模式...')
      // 尝试旧的匹配模式
      const patterns = [
        /window\.__INITIAL_STATE__\s*=\s*([\s\S]*?);/,
        /window\['__INITIAL_STATE__'\]\s*=\s*([\s\S]*?);/,
        /__INITIAL_STATE__\s*=\s*([\s\S]*?);\s*\(/,
        /__INITIAL_STATE__\s*=\s*([\s\S]*?);\s*<\/script>/
      ]

      for (let i = 0; i < patterns.length; i++) {
        const pattern = patterns[i]
        videoInfo = html.match(pattern)
        if (videoInfo) {
          console.log(`使用第${i + 1}个匹配模式成功`)
          break
        }
      }
    }

    if (!videoInfo) {
      console.error('EP解析失败：无法找到有效的数据源')
      throw new Error('parse ep error: 未找到有效的视频数据')
    }

    console.log('成功提取__INITIAL_STATE__数据')
    const initialStateData = JSON.parse(videoInfo[1])
    console.log('__INITIAL_STATE__数据结构:', Object.keys(initialStateData))

    const { h1Title, mediaInfo, epInfo, epList } = initialStateData
    if (!h1Title || !mediaInfo || !epInfo) {
      console.error('EP数据结构不完整:', {
        hasH1Title: !!h1Title,
        hasMediaInfo: !!mediaInfo,
        hasEpInfo: !!epInfo,
        hasEpList: !!epList
      })
      throw new Error('parse ep error: EP数据结构不完整')
    }
    console.log('EP基本信息:', {
      title: h1Title,
      cid: epInfo.cid,
      bvid: epInfo.bvid,
      epCount: epList?.length || 0
    })
    // 获取视频下载地址
    let acceptQuality = null
    try {
      console.log('尝试从HTML中提取__playinfo__数据')
      let downLoadData: any = html.match(/\<script\>window\.\_\_playinfo\_\_\=([\s\S]*?)\<\/script\>\<script\>window\.\_\_INITIAL\_STATE\_\_\=/)
      if (!downLoadData) {
        console.log('HTML中未找到__playinfo__数据，将通过API获取')
        throw new Error('playinfo not found in html')
      }
      downLoadData = JSON.parse(downLoadData[1])
      console.log('成功解析__playinfo__数据:', !!downLoadData.data)
      acceptQuality = {
        accept_quality: downLoadData.data.accept_quality,
        video: downLoadData.data.dash.video,
        audio: downLoadData.data.dash.audio
      }
    } catch (error) {
      console.log('通过API获取视频清晰度信息')
      acceptQuality = await getAcceptQuality(epInfo.cid, epInfo.bvid)
    }
    // 检查用户权限和可用清晰度
    const userLevel = await getUserLevel()
    const availableQualities = filterQualitiesByUserLevel(acceptQuality.accept_quality, userLevel)
    console.log(`EP用户等级: ${userLevel}, 原始清晰度:`, acceptQuality.accept_quality)
    console.log('EP用户可用清晰度:', availableQualities)

    const obj: VideoData = {
      id: '',
      title: h1Title,
      url,
      bvid: epInfo.bvid,
      cid: epInfo.cid,
      cover: `http:${mediaInfo.cover}`,
      createdTime: -1,
      quality: -1,
      view: mediaInfo.stat.views,
      danmaku: mediaInfo.stat.danmakus,
      reply: mediaInfo.stat.reply,
      duration: formatSeconed(epInfo.duration / 1000),
      up: [{ name: mediaInfo.upInfo.name, mid: mediaInfo.upInfo.mid }],
      qualityOptions: availableQualities.map((item: any) => ({ label: qualityMap[item], value: item })),
      page: parseEPPageData(epList),
      subtitle: [],
      video: acceptQuality.video ? acceptQuality.video.map((item: any) => ({ id: item.id, cid: epInfo.cid, url: item.baseUrl })) : [],
      audio: acceptQuality.audio ? acceptQuality.audio.map((item: any) => ({ id: item.id, cid: epInfo.cid, url: item.baseUrl })) : [],
      filePathList: [],
      fileDir: '',
      size: -1,
      downloadUrl: { video: '', audio: '' }
    }
    console.log('ep')
    console.log(obj)
    return obj
  } catch (error: any) {
    console.error('EP解析完全失败:', error)
    throw new Error(`EP解析失败: ${error.message || error}`)
  }
}

const parseSS = async (html: string) => {
  try {
    const videoInfo = html.match(/\<script\>window\.\_\_INITIAL\_STATE\_\_\=([\s\S]*?)\;\(function\(\)\{var s\;/)
    if (!videoInfo) throw new Error('parse ss error')
    const { mediaInfo } = JSON.parse(videoInfo[1])
    const params = {
      url: `https://www.bilibili.com/bangumi/play/ep${mediaInfo.newestEp.id}`,
      config: {
        headers: {
          'User-Agent': `${UA}`,
          cookie: `SESSDATA=${store.settingStore(pinia).SESSDATA}`
        }
      }
    }
    const { body } = await window.electron.got(params.url, params.config)
    return parseEP(body, params.url)
  } catch (error: any) {
    throw new Error(error)
  }
}

// 获取视频清晰度列表
const getAcceptQuality = async (cid: string, bvid: string) => {
  try {
    const SESSDATA = store.settingStore(pinia).SESSDATA
    const bfeId = store.settingStore(pinia).bfeId
    const config = {
      headers: {
        'User-Agent': `${UA}`,
        cookie: `SESSDATA=${SESSDATA};bfe_id=${bfeId}`
      },
      responseType: 'json'
    }
    console.log(`获取视频清晰度列表 - cid: ${cid}, bvid: ${bvid}`, {
      hasSESSDATA: !!SESSDATA,
      hasBfeId: !!bfeId
    })
    const { body: { data: { accept_quality, dash: { video, audio } } }, headers: { 'set-cookie': responseCookies } } = await window.electron.got(
      `https://api.bilibili.com/x/player/playurl?cid=${cid}&bvid=${bvid}&qn=127&type=&otype=json&fourk=1&fnver=0&fnval=80&session=68191c1dc3c75042c6f35fba895d65b0`,
      config
    )
    console.log('获取到的清晰度选项:', accept_quality)
    console.log('视频流数量:', video?.length || 0)
    console.log('音频流数量:', audio?.length || 0)
    // 保存返回的cookies
    saveResponseCookies(responseCookies)
    return {
      accept_quality,
      video,
      audio
    }
  } catch (error: any) {
    console.error(`获取视频清晰度列表失败 - cid: ${cid}, bvid: ${bvid}:`, error.message)
    throw new Error(`获取视频清晰度列表失败: ${error.message}`)
  }
}

// 获取指定清晰度视频下载地址
const getDownloadUrl = async (cid: number, bvid: string, quality: number) => {
  try {
    // 首先验证用户对该清晰度的权限
    await validateQualityPermission(quality)

    const SESSDATA = store.settingStore(pinia).SESSDATA
    const bfeId = store.settingStore(pinia).bfeId
    const config = {
      headers: {
        'User-Agent': `${UA}`,
        // bfe_id必须要加
        cookie: `SESSDATA=${SESSDATA};bfe_id=${bfeId}`
      },
      responseType: 'json'
    }
    console.log(`获取下载地址 - cid: ${cid}, bvid: ${bvid}, quality: ${quality}`, {
      hasSESSDATA: !!SESSDATA,
      hasBfeId: !!bfeId
    })
    const { body, headers: { 'set-cookie': responseCookies } } = await window.electron.got(
      `https://api.bilibili.com/x/player/playurl?cid=${cid}&bvid=${bvid}&qn=${quality}&type=&otype=json&fourk=1&fnver=0&fnval=80&session=68191c1dc3c75042c6f35fba895d65b0`,
      config
    )
    console.log('API返回的原始数据:', body)

    if (body.code !== 0) {
      console.error(`API返回错误码: ${body.code}, 消息: ${body.message}`)
      throw new Error(`API错误: ${body.message} (码: ${body.code})`)
    }

    const { data: { dash } } = body
    if (!dash || !dash.video || !dash.audio) {
      console.error('视频数据缺失:', {
        hasDash: !!dash,
        hasVideo: dash?.video?.length > 0,
        hasAudio: dash?.audio?.length > 0
      })
      throw new Error('视频数据缺失，可能是权限不足或视频不存在')
    }

    console.log('可用视频流:', dash.video.map((v: any) => ({ id: v.id, codecs: v.codecs })))
    console.log('可用音频流:', dash.audio.map((a: any) => ({ id: a.id, codecs: a.codecs })))

    const targetVideo = dash.video.find((item: any) => item.id === quality)
    if (!targetVideo) {
      console.warn(`未找到指定清晰度 ${quality}，使用默认清晰度`)
    }

    // 保存返回的cookies
    saveResponseCookies(responseCookies)
    return {
      video: targetVideo ? targetVideo.baseUrl : dash.video[0].baseUrl,
      audio: getHighQualityAudio(dash.audio).baseUrl
    }
  } catch (error: any) {
    console.error(`获取下载地址失败 - cid: ${cid}, bvid: ${bvid}, quality: ${quality}:`, error.message)
    throw new Error(`获取下载地址失败: ${error.message}`)
  }
}

// 获取视频字幕
const getSubtitle = async (cid: number, bvid: string) => {
  const SESSDATA = store.settingStore(pinia).SESSDATA
  const bfeId = store.settingStore(pinia).bfeId
  const config = {
    headers: {
      'User-Agent': `${UA}`,
      cookie: `SESSDATA=${SESSDATA};bfe_id=${bfeId}`
    },
    responseType: 'json'
  }
  const { body: { data: { subtitle } } } = await window.electron.got(`https://api.bilibili.com/x/player/v2?cid=${cid}&bvid=${bvid}`, config)
  const subtitleList: Subtitle[] = subtitle.subtitles ? subtitle.subtitles.map((item: any) => ({ title: item.lan_doc, url: item.subtitle_url })) : []
  return subtitleList
}

// 处理filePathList
const handleFilePathList = (page: number, title: string, up: string, bvid: string, id: string): string[] => {
  const downloadPath = store.settingStore().downloadPath
  const name = `${!page ? '' : `[P${page}]`}${filterTitle(`${title}-${up}-${bvid}-${id}`)}`
  const isFolder = store.settingStore().isFolder
  return [
    `${downloadPath}/${isFolder ? `${name}/` : ''}${name}.mp4`,
    `${downloadPath}/${isFolder ? `${name}/` : ''}${name}.png`,
    `${downloadPath}/${isFolder ? `${name}/` : ''}${name}-video.m4s`,
    `${downloadPath}/${isFolder ? `${name}/` : ''}${name}-audio.m4s`,
    isFolder ? `${downloadPath}/${name}/` : ''
  ]
}

// 处理fileDir
const handleFileDir = (page: number, title: string, up: string, bvid: string, id: string): string => {
  const downloadPath = store.settingStore().downloadPath
  const name = `${!page ? '' : `[P${page}]`}${filterTitle(`${title}-${up}-${bvid}-${id}`)}`
  const isFolder = store.settingStore().isFolder
  return `${downloadPath}${isFolder ? `/${name}/` : ''}`
}

// 处理bv多p逻辑
const parseBVPageData = ({ bvid, title, pages }: { bvid: string, title: string, pages: any[] }, url: string): Page[] => {
  const len = pages.length
  if (len === 1) {
    return [
      {
        title,
        url,
        page: pages[0].page,
        duration: formatSeconed(pages[0].duration),
        cid: pages[0].cid,
        bvid: bvid
      }
    ]
  } else {
    return pages.map(item => ({
      title: item.part,
      page: item.page,
      duration: formatSeconed(item.duration),
      cid: item.cid,
      bvid: bvid,
      url: `${url}?p=${item.page}`
    }))
  }
}

// 处理ep多p逻辑
const parseEPPageData = (epList: any[]): Page[] => {
  return epList.map((item, index) => ({
    title: item.share_copy,
    page: index + 1,
    duration: formatSeconed(item.duration / 1000),
    cid: item.cid,
    bvid: item.bvid,
    url: item.share_url
  }))
}

// 从 __NEXT_DATA__ 解析EP数据
const parseEPFromNextData = async (nextDataJson: string, url: string) => {
  try {
    console.log('开始解析__NEXT_DATA__')
    const nextData = JSON.parse(nextDataJson)
    console.log('__NEXT_DATA__结构:', Object.keys(nextData))
    
    // 从dehydratedState中提取数据
    const queries = nextData.props?.pageProps?.dehydratedState?.queries
    if (!queries || queries.length === 0) {
      throw new Error('__NEXT_DATA__中未找到queries数据')
    }
    
    console.log('找到queries数据:', queries.length, '个')
    
    // 查找包含视频信息的query
    const videoQuery = queries.find((query: any) => 
      query.state?.data?.data?.result?.video_info || 
      query.state?.data?.result?.video_info
    )
    
    if (!videoQuery) {
      console.error('未找到视频信息的query')
      queries.forEach((query: any, index: number) => {
        console.log(`Query ${index}:`, Object.keys(query.state?.data || {}))
      })
      throw new Error('未找到视频播放信息')
    }
    
    console.log('找到视频信息query')
    const videoData = videoQuery.state.data.data?.result || videoQuery.state.data.result
    const videoInfo = videoData.video_info
    
    console.log('视频基本信息:', {
      accept_quality: videoInfo.accept_quality,
      accept_description: videoInfo.accept_description,
      timelength: videoInfo.timelength
    })
    
    // 构造视频数据（简化版，主要用于下载）
    const userLevel = await getUserLevel()
    const availableQualities = filterQualitiesByUserLevel(videoInfo.accept_quality, userLevel)
    console.log(`EP用户等级: ${userLevel}, 原始清晰度:`, videoInfo.accept_quality)
    console.log('EP用户可用清晰度:', availableQualities)
    
    // 提取ep信息（从URL解析）
    const epIdMatch = url.match(/ep(\d+)/)
    const epId = epIdMatch ? epIdMatch[1] : 'unknown'
    
    const obj: VideoData = {
      id: '',
      title: `EP${epId}`, // 临时标题，可能需要通过API获取完整信息
      url,
      bvid: '', // 番剧可能没有bvid
      cid: 0, // 需要通过其他方式获取
      cover: '', // 需要通过其他方式获取
      createdTime: -1,
      quality: -1,
      view: 0,
      danmaku: 0,
      reply: 0,
      duration: formatSeconed(Math.floor(videoInfo.timelength / 1000)),
      up: [{ name: '哔哩哔哩', mid: 0 }], // 番剧的发布者
      qualityOptions: availableQualities.map((item: any) => ({ label: qualityMap[item], value: item })),
      page: [{
        title: `EP${epId}`,
        page: 1,
        duration: formatSeconed(Math.floor(videoInfo.timelength / 1000)),
        cid: 0, // 需要获取
        bvid: '',
        url: url
      }],
      subtitle: [],
      video: [], // 需要通过API获取
      audio: [], // 需要通过API获取
      filePathList: [],
      fileDir: '',
      size: -1,
      downloadUrl: { video: '', audio: '' }
    }
    
    console.log('EP解析完成（简化版）:', obj)
    return obj
  } catch (error: any) {
    console.error('__NEXT_DATA__解析失败:', error)
    throw new Error(`__NEXT_DATA__解析失败: ${error.message}`)
  }
}

// 获取码率最高的audio
const getHighQualityAudio = (audioArray: any[]) => {
  return audioArray.sort((a, b) => b.id - a.id)[0]
}

// 获取当前用户等级
const getUserLevel = async () => {
  try {
    const SESSDATA = store.settingStore(pinia).SESSDATA
    if (!SESSDATA) {
      console.log('未登录，返回游客权限')
      return 0
    }
    const userLevel = await checkLogin(SESSDATA)
    console.log(`检测到用户等级: ${userLevel} (0=游客, 1=普通用户, 2=大会员)`)
    return userLevel
  } catch (error) {
    console.error('获取用户等级失败，默认为游客权限:', error)
    return 0
  }
}

// 根据用户等级筛选可用清晰度
const filterQualitiesByUserLevel = (availableQualities: number[], userLevel: number) => {
  const userAllowedQualities = userQuality[userLevel] || userQuality[0]
  const filteredQualities = availableQualities.filter(quality =>
    userAllowedQualities.includes(quality)
  )

  if (filteredQualities.length === 0) {
    console.warn('用户权限筛选后无可用清晰度，使用最低清晰度')
    return [availableQualities[availableQualities.length - 1]]
  }

  console.log(`权限筛选: 原始${availableQualities.length}个 -> 可用${filteredQualities.length}个`)
  return filteredQualities
}

// 验证清晰度权限
const validateQualityPermission = async (quality: number) => {
  const userLevel = await getUserLevel()
  const allowedQualities = userQuality[userLevel] || userQuality[0]

  if (!allowedQualities.includes(quality)) {
    const qualityName = qualityMap[quality] || `清晰度${quality}`
    const levelName = userLevel === 0 ? '游客' : userLevel === 1 ? '普通用户' : '大会员'
    throw new Error(`${levelName}无权限访问${qualityName}，请选择其他清晰度或升级会员`)
  }

  console.log(`清晰度权限验证通过: ${qualityMap[quality]} (用户等级: ${userLevel})`)
  return true
}

export {
  checkLogin,
  checkUrl,
  checkUrlRedirect,
  parseHtml,
  getDownloadList,
  addDownload
}
