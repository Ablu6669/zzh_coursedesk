# 课件台 CourseDeck

面向港中深学生的课件工作台：一门课一个知识库，上传 PDF / PPT / Word，划词问 AI、全文翻译、手写批注、一键导出，账号跨设备同步。

纯静态前端（零构建）+ 腾讯云 CloudBase 云函数后端，可直接托管到 GitHub Pages。

## 功能

| 模块 | 能力 |
|---|---|
| 知识库 | 多知识库管理，支持多选 / 文件夹批量导入 |
| 阅读 | PDF 原生渲染（pdf.js）；PPTX / DOCX 解析为统一分页模型，页码与阅读器一致 |
| 标注 | 文本高亮（黑 / 红 / 蓝 / 黄）、手写笔迹（钢笔 / 荧光笔）、批注备注，逐笔自动保存 |
| 翻译 | 整页翻译 / 中英对照，专用翻译模型 |
| 问答 | 划词问 AI、快捷指令、基于课件切块的 RAG 检索（带引用跳转），可开关联网搜索 |
| 导出 | 导出带标注的 PDF、笔记 Markdown |
| 同步 | 邮箱 + 密码登录，课件 / 标注 / 译文 / 索引存云端，换设备继续 |

## 技术架构

```
coursedeck/
├── index.html / css / js    零构建纯静态前端（CDN 引入 pdf.js、mammoth、JSZip）
├── cloudfunctions/          5 个云函数（cd-login / cd-data / cd-ingest / cd-ask / cd-translate）
├── deploy/                  部署与构建脚本
└── docs/                    竞品调研、云端部署指南
```

后端 5 个云函数均带 HTTP/CORS 适配层，可走「HTTP 访问服务」跨域调用，因此托管在任意域名（含 GitHub Pages）都能直连，不依赖安全域名白名单。

AI 分工：翻译用专用翻译模型，问答用推理模型，检索用向量模型（三者独立配置，互不影响）。

## 快速开始

**仅本机体验（零配置）**

直接用浏览器打开 `index.html` —— 数据存在浏览器 IndexedDB，换设备看不到。

**接入云端（多设备同步）**

1. 腾讯云控制台创建 CloudBase 环境，开启匿名登录
2. `cp deploy/config.example.json deploy/config.json`，填入 SecretId / SecretKey
3. `cp deploy/env.example.js deploy/env.js`，填入云环境 ID 与 HTTP 访问服务域名
4. `node deploy/setup.js` 一键建集合 + 部署云函数
5. `node deploy/build.js` 生成 `dist/`（腾讯云托管）与 `dist-gh/`（GitHub Pages）

详细步骤见 `docs/云端部署指南.md`。

## 安全设计

**本仓库不含任何密钥。** 以下文件已被 `.gitignore` 排除，不会进版本库：

| 文件 | 内容 | 模板 |
|---|---|---|
| `deploy/config.json` | 腾讯云 SecretId / SecretKey、SMTP 授权码、AI API Key | `deploy/config.example.json` |
| `cloudbaserc.local.json` | 云函数环境变量（含上述全部密钥） | `cloudbaserc.json` |
| `deploy/env.js` | 云环境 ID 与 HTTP 域名 | `deploy/env.example.js` |

其他安全措施：

- **AI 配额隔离**：服务端 AI 密钥仅对管理员账号（`ADMIN_EMAILS`）生效；其他账号在设置里填自己的 API Key，只存在本机浏览器，走本地直连。
- **注册门槛**（可选）：公开部署后可防止任意邮箱注册、占用云资源。设 `ALLOW_SIGNUP` 环境变量：
  - 不设 / `open`：完全开放（默认）
  - `off`：关闭注册
  - `domain`：仅允许指定邮箱域名（配合 `ALLOW_EMAIL_DOMAINS`，如 `link.cuhk.edu.cn`）
  - `invite`：需邀请码（配合 `INVITE_CODE`）
- **数据隔离**：所有云函数读写均按登录 token 校验 `email`，账号之间不可见。

## 说明

- 课件文件本身（PDF/PPTX/DOCX）涉及版权，`test/` 下的样例文件默认不入库。
- 云函数调用需有效登录 token；公开托管时建议开启注册门槛，避免云资源被滥用。
