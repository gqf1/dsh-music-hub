dsh-music-hub —— 第三方代码来源与许可
=====================================

本项目 lib/sources/ 下的以下文件移植自开源项目：

  项目：dsh-music-player 1.0.3
  作者：kendu76（npm 维护者 hhdsq1976）
  仓库：https://github.com/kendu76/dsh-music-player
  许可：MIT License（见下方原文）

被移植并做了适配的文件：
  lib/sources/kugou.js    —— 酷狗签名/设备注册/扫码登录/取链/歌单/歌词（KRC）
  lib/sources/krc.js      —— 酷狗逐字歌词 KRC 解码
  lib/sources/qq.js       —— QQ 音乐扫码登录/搜索/取链/歌单/歌词（搜索端点已按 2026-10-27 实测改为 search_cp）
  lib/sources/qrc.js      —— QQ 逐字歌词 QRC 解码
  lib/sources/netease.js  —— 网易云扫码登录/搜索/取链/歌单/歌词
  lib/sources/yrc.js      —— 网易云逐字歌词 YRC 解码
  lib/sources/vendor/qrcode.mjs —— 纯 JS 二维码生成（用于网易云登录链接转图）

本插件自身编写（非移植）的部分：
  lib/index.js、lib/local.js、lib/online.js、lib/client.js、lib/sources/lrc.js

--------------------------------------------------------------------
MIT License

Copyright (c) kendu76

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
--------------------------------------------------------------------

合规提示：QQ 音乐 / 酷狗 / 网易云均通过非官方接口访问，内容版权归各平台与版权方所有。
本项目仅用于个人学习与本地试听，严禁商业用途、公开传播或二次分发；账号风控风险自负。
