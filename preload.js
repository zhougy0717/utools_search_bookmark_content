const path = require('path')
const fs = require('fs')
const http = require('http');
const https = require('https');
// const { shell } = require('electron')
const cp = require('child_process')
let bookmarksDataCache = null
let tabListCache = []
let g_savedUrl = []
let g_dataCache = []

function getChromeBookmarks () {
  let chromeDataDir = ''
  const profiles = ['Default', 'Profile 3', 'Profile 2', 'Profile 1']
  if (process.platform === 'win32') {
    chromeDataDir = path.join(process.env['LOCALAPPDATA'], 'Google/Chrome/User Data')
  } else if (process.platform === 'darwin') {
    chromeDataDir = path.join(window.utools.getPath('appData'), 'Google/Chrome')
  } else if (process.platform === 'linux') {
    chromeDataDir = path.join(window.utools.getPath('appData'), 'google-chrome')
  }
  const profile = profiles.find(profile => fs.existsSync(path.join(chromeDataDir, profile, 'Bookmarks')))
  if (!profile) return []
  const bookmarkPath = path.join(chromeDataDir, profile, 'Bookmarks')
  const bookmarksData = []
  try {
    const data = JSON.parse(fs.readFileSync(bookmarkPath, 'utf-8'))
    const getUrlData = (item) => {
      if (!item || !Array.isArray(item.children)) return
      item.children.forEach(c => {
        if (c.type === 'url') {
          bookmarksData.push(c)
        } else if (c.type === 'folder') {
          getUrlData(c)
        }
      })
    }
    getUrlData(data.roots.bookmark_bar)
    getUrlData(data.roots.other)
    getUrlData(data.roots.synced)
  } catch (e) {}
  return bookmarksData
}

stripScriptNode = (html) =>{
  return html.replace(/\<script\b[^<]*(?:(?!\<\/script\>)\<[^<]*)*\<\/script\>/gi, '')
}

stripAllNodes = (html) => {
  return html.replace(/<[^>]+>/g, '')
}

deleteEmptyLines = (txt) => {
  txt = txt.replace(/^\s*[\r\n]/gm, '');
  txt = txt.replace(/\#\d*/g, '');
  return txt
}

isIpv4Addr = (txt) => {
  const pattern = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/
  return pattern.test(txt)
}

sendHttpReq = (url) => {
  const httpLib = url.url.startsWith('https') ? https : http
  const parsedUrl = new URL(url.url)
  const port = parsedUrl.port ?? (parsedUrl.protocol === 'http' ? 80 : 443);
  const options = {
    hostname: parsedUrl.hostname,
    port: port,
    path: parsedUrl.pathname,
    method: 'GET',
    timeout: 1000,
    headers: {
        'Content-Type': 'text/html',
    }
  };
  httpLib.get(url.url, options, (response) => {
    if (response.statusCode != 200) {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        // 处理重定向
        console.log('Received redirect response. Redirecting to: ' + response.headers.location);

        let redirected = response.headers.location
        if (redirected.startsWith('//')) {
          redirected = `${parsedUrl.protocol}${redirected}`
        }
        else if (redirected.startsWith('/')) {
          redirected = `${parsedUrl.protocol}//${parsedUrl.hostname}${redirected}`
        }
        url.url = redirected
        try {
          const parsed = new URL(url.url)
        }
        catch (error) {
          console.log(error)
        }
        return sendHttpReq(url)
      }
      else {
        console.log('status code', response.statusCode, url.url);
        return
      }
    }
    let data = '';
    
    // 数据接收完成时的处理
    response.on('data', (chunk) => {
      data += chunk;
    });

    response.on('end', () => {
      // 将获取到的网页内容写入文件
      data = stripScriptNode(data)
      data = stripAllNodes(data)
      data = deleteEmptyLines(data)
      // console.log('网页下载成功！');
      try {
        const item = {
          data: data,
          url: url.url,
          title: url.name
        }
        window.utools.dbStorage.setItem(url.guid, item)
        if (!g_savedUrl.includes(url.guid)) {
          g_savedUrl.push(url.guid)
          window.utools.dbStorage.setItem("savedUrl", g_savedUrl)
        }

      } catch (error) {
        console.error('存储网页时出错：', url.url);
        
      }
    });
  }).on('error', (error) => {
    console.error('下载网页时出错：', url.url, error);
  });
}

getRelatedContent = (cached, searchWord, cb) => {
  let items = []
  cached.forEach(item => {
    if (!item.data.includes(searchWord)) {
      return
    }
    let matches = [];
    let startIndex = 0;
    
    while (startIndex < item.data.length) {
        let index = item.data.indexOf(searchWord, startIndex);
        let before = ""
        let after = ""
        if (index === -1) {
            break; // 如果找不到子字符串，则退出循环
        }
        if (index <= 5) {
          before = item.data.substring(0, index)
        }
        else {
          before = item.data.substring(index - 5, index);
        }
        if (item.data.length - searchWord.length - index <= 5) {
          after = item.data.substring(index + searchWord.length)
        }
        else {
          after = item.data.substring(index + searchWord.length, index + searchWord.length + 5)
        }
        matches.push(`${before}${searchWord}${after}`)
        
        startIndex = index + searchWord.length; // 从下一个位置开始继续搜索
    }
    const joinedTxt = matches.join('...')
    items.push({
      title: item.title,
      description: joinedTxt,
      icon: "logo.png",
      url: item.url,
      data: item.data
    })
  })
  cb(items)
}

function debounce(func, wait) {
  let timeout;

  // 返回一个新的函数，用于实际调用
  return function(...args) {
      // 保存上下文和参数，供后续使用
      const context = this;

      // 如果已经设定了等待执行的函数，则清除之前的计时器
      if (timeout) clearTimeout(timeout);

      // 设定一个新的计时器
      // 计时器结束后，执行实际的函数
      timeout = setTimeout(() => {
          // func.apply(context, args);
          func(...args)
      }, wait);
  };
}

const searchDebounced = debounce(getRelatedContent, 300)

window.exports = {
  'bm_content': {
    mode: 'list',
    args: {
      enter: (action) => {
        bookmarksDataCache = getChromeBookmarks()
        g_savedUrl = window.utools.dbStorage.getItem("savedUrl") ?? []
        g_savedUrl.forEach(guid => {
          const saved = window.utools.dbStorage.getItem(guid) ?? ""
          if (saved !== "") {
            g_dataCache.push(saved)
          }
        })
        bookmarksDataCache.forEach(url => {
          if (g_savedUrl.includes(url.guid)) {
            return
          }
          // 发起HTTP GET请求
          const saved = window.utools.dbStorage.getItem(url.guid) ?? ""
          if (saved !== "") {
            return
          }
          if (!url.url.startsWith('http') && !url.url.startsWith('https')) {
            return
          }
          if (url.url.includes('huawei')) {
            return
          }

          const parsedUrl = new URL(url.url)
          if (isIpv4Addr(parsedUrl.hostname)) {
            return
          }
          
          try {
            sendHttpReq(url)
          } catch(error) {
            console.error('连接出错：', url.url);
          }
        })
      },
      search: (action, searchWord, callbackSetList) => {
        if (searchWord == "") {
          callbackSetList([])
          return
        }
        searchDebounced(g_dataCache, searchWord, callbackSetList)
      },
      select: (action, itemData) => {
        window.utools.hideMainWindow()
        utools.shellOpenExternal(itemData.url)
      }
    }
  }
}
