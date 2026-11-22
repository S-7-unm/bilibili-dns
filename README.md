# B站加速 · Loon 插件

把 [realzza/bilibili-accelerator](https://github.com/realzza/bilibili-accelerator) 这套海外看 B 站的加速思路搬到 Loon 上，并配好自动更新链路。

上游是一个浏览器油猴脚本：它劫持页面的 `JSON.parse` / `fetch`，在播放器开始缓冲之前把播放接口返回的慢 CDN 地址改掉。本插件用 Loon 的能力做等价实现，分成两层：

| 层 | 做法 | 生效范围 |
| --- | --- | --- |
| 第一层（主体） | `[Rule]` 把 B 站视频 / 直播 CDN 域名导向 `PROXY` | 所有 App 与浏览器，装好即用 |
| 第二层（增强） | MitM + Response Script 改写播放接口里的线路地址 | 需装证书；浏览器稳定生效，原生 App 取决于是否证书固定 |

第二层与上游原理一致，只是执行位置从页面里换到了代理层。

---

## 能力边界（先说清楚，免得装完失望）

上游作者在自己的文档里已经写明路由级方案的天花板，这里照实搬过来：

| 场景 | 第一层分流 | 第二层改写 |
| --- | --- | --- |
| iOS / macOS Safari、Chrome 看 B 站网页 | ✅ 生效 | ✅ 生效（需证书） |
| B 站 iPhone / iPad 客户端 | ✅ 生效 | ⚠️ 取决于 App 是否做证书固定，固定则完全无效 |
| Apple TV 上的 B 站 | ✅ 生效（Loon tvOS 端） | ❌ 证书难以安装 |
| 版权地区限制、片源本身有问题、本地网络问题 | ❌ | ❌ |

第二层是**增强项**，默认关闭。先只开第一层，觉得不够再开第二层。

---

## 安装

### 1. 准备仓库（自动更新用）

1. 新建一个 GitHub 仓库，把本目录整体推上去（`.github/` 目录结构不要改）。
2. 打开仓库 **Settings → Actions → General**，Workflow permissions 选 **Read and write permissions**（否则每天自动同步提交不上去）。
3. 把插件和脚本里的两处占位地址换成你自己的：

   把 `CHANGE_ME_OWNER` 换成 GitHub 用户名，`CHANGE_ME_REPO` 换成仓库名，共 3 处：

   - `BiliBili-Accelerator.plugin` 里两条 `script("https://cdn.jsdelivr.net/gh/CHANGE_ME_OWNER/CHANGE_ME_REPO@main/...")`
   - 同文件 `[Argument]` 里的 `ruleset_url` 默认值

   本地一条命令搞定：

   ```bash
   sed -i '' 's/CHANGE_ME_OWNER/你的用户名/g; s/CHANGE_ME_REPO/你的仓库名/g' BiliBili-Accelerator.plugin
   ```

### 2. Loon 导入插件

Loon → 配置 → 插件 → 右上角 `+` → 粘贴插件地址：

```
https://cdn.jsdelivr.net/gh/你的用户名/你的仓库名@main/BiliBili-Accelerator.plugin
```

> 用 jsDelivr 而不是 `raw.githubusercontent.com`，国内可达性好得多。也可以换成 GitHub Pages 地址，效果一样。
>
> 不想开仓库的话：把 `.plugin` 和 `Scripts/` 下两个 `.js` 存到 Loon 脚本目录，把插件里的脚本地址改成本地文件名（例如 `script("bili-playurl-rewrite.js")`）。代价是以后要手动更新。

### 3. 让分流真正加速

插件规则只能引用 `DIRECT` / `REJECT` 系列 / `PROXY` 三类策略，这是 Loon 对插件的限制。所以必须给 `PROXY` 绑定一个国内落地节点：

Loon → 策略组 → 编辑 `PROXY` → 选你的国内节点（或建一个 `url-test` 组专门放国内节点，再把 `PROXY` 指向它）。

这一步没做，插件等于只是把 CDN 域名匹配了一遍，不会有加速效果。

### 4.（可选）开启第二层改写

1. Loon → 配置 → MitM → 生成证书 → 安装描述文件；
2. iOS 设置 → 通用 → 关于本机 → 证书信任设置 → 开启 Loon 根证书信任；
3. 打开 MitM、脚本、复写三个开关；
4. 插件参数里把「启用换线路」打开，模式选 `backup`。

---

## 插件参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| 启用换线路 | 关 | 第二层总开关，依赖证书 |
| 换线路模式 | `backup` | 见下表 |
| 固定线路 host | 空 | 仅 `fixed` 模式生效 |
| 启用定时探测 | 关 | 开启后才会周期性测速 |
| 探测周期 | `0 */4 * * *` | Cron 表达式 |
| 线路清单地址 | 仓库 `build/cdn-hosts.json` | 留空则只用内置白名单 |
| 探测指定策略 | 空 | 留空跟随当前路由 |
| 探测结果通知 | 关 | 线路变化时推送一次 |
| 两个调试日志 | 关 | 排查时打开，看完记得关 |

四种模式：

| 模式 | 行为 | 建议 |
| --- | --- | --- |
| `off` | 只分流，不碰播放接口 | 没装证书时用 |
| `backup` | 改用播放接口自带的备用线路地址 | **默认**，地址由 B 站下发，最安全 |
| `probe` | 按定时探测出的最快线路改写；探测数据缺失时自动退回 `backup` | 开了探测再用 |
| `fixed` | 固定用你填的 host | 明确知道哪条线路好再用 |

---

## 自动更新是怎么跑起来的

`.github/workflows/sync-upstream.yml` 每天 01:17（北京时间）执行一次：

1. `node --check` 校验两个脚本语法；
2. `build/lint-plugin.mjs` 校验插件结构 —— 缺 `#!name`、Response Script 没写 URL Guard、没写 `requires_body=true`、引用了未声明参数、`[MitM]` 没声明 hostname、规则用了插件不允许的策略，都会直接报错让工作流失败，不推坏插件；
3. `node test/run-tests.mjs` 跑逻辑回归（用模拟的 Loon 运行时，覆盖 dash / durl / 直播三类响应和四种模式）；
4. `build/sync-upstream.mjs` 从上游抓取用户脚本，抽出里面真实出现过的媒体 CDN host，合并进 `build/cdn-hosts.json`，并刷新 `.plugin` 的 `#!date`；
5. 有变更就提交推送。

更新到达设备的路径有两条：

- **插件本体**：Loon 对 URL 安装的插件会定期检查更新，`#!date` 变了就拉新版；
- **线路清单**：脚本运行时按 12 小时 TTL 拉 `cdn-hosts.json`，Actions 更新了清单，设备侧半天内自动跟上，不用重装插件。

手动触发：仓库 → Actions → 该工作流 → Run workflow。

`#!source` 故意留空 —— 它会把插件锁定在某个具体下载地址的哈希上，换域名或换托管方式就会校验失败，对自动更新是负资产。

---

## 验证有没有生效

- **第一层**：Loon → 仪表 / 域名请求，播放时看 `bilivideo.com` 是否命中规则并走 `PROXY`。
- **第二层**：插件里打开「改写调试日志」，Loon 日志应出现 `biliAccel` 一条，包含 `mode` / `from` / `to` / `rewritten`。
- **探测**：手动跑一次 cron 脚本（或在 Loon 脚本页手动执行「B站线路探测」），日志里 `step:"done"`，`reason` 为 `ok` 即成功。

`reason` 的其他取值都是安全退出，不是故障：

| reason | 含义 |
| --- | --- |
| `no sample yet` | 还没播放过，没有可测地址；先看一段视频再跑 |
| `sample stale` | 样本超过 12 小时，签名已过期 |
| `all failed` | 所有线路探测失败，保留上一次的结论不覆盖 |
| `cached` | 清单在 TTL 内，跳过拉取 |

---

## 文件结构

```
BiliBili-Accelerator.plugin        插件本体（规则 + 参数 + MitM + 脚本挂载）
Scripts/bili-playurl-rewrite.js    Response Script：改写播放接口的线路地址
Scripts/bili-line-probe.js         Cron Script：同步清单 + 实测线路快慢
build/cdn-hosts.json               线路清单（Actions 维护，勿手改）
build/sync-upstream.mjs            同步脚本
build/lint-plugin.mjs              插件结构检查
rules/bili-cdn.list                可选 Remote Rule 订阅源（与内置规则重复，二选一）
test/run-tests.mjs                 逻辑回归测试（29 项）
.github/workflows/sync-upstream.yml 每日自动同步
```

## 本地自检

```bash
node --check Scripts/bili-playurl-rewrite.js
node --check Scripts/bili-line-probe.js
node build/lint-plugin.mjs
node test/run-tests.mjs
node build/sync-upstream.mjs          # 需要能访问 GitHub
```

测试覆盖：dash 音画同步切线、durl 多段统一切线、直播 `getRoomPlayInfo`、签名参数与路径完整性、`code != 0` / 非 JSON / 单线路 / 第三方域名一律放行、`fixed` 拒绝白名单外 host、探测结果过期回退、全线路失败不覆盖旧值。

## 已知限制与说明

- 第二层会改写响应体，脚本里已处理：只换 host、`path` 与 `query`（含签名）原样保留、改写后移除 `Content-Length`、任何异常一律原样放行。
- 探测脚本会在本机持久化存储里保留一条媒体地址样本（路径截断到 180 字符）用于测速，只存在本机、不外发。
- `real-ip` 里加了媒体域名，避免 fake-ip 模式下 CDN 按虚拟 IP 调度导致绕路。
- 上游脚本的面板、测速曲线、7 套主题色这类 UI 不做移植：代理层没有页面 DOM，这部分留在浏览器里更合适。
- 工程文件名保持英文，`.github/workflows/` 路径与 jsDelivr 地址是硬约束。

## 许可与出处

加速思路与线路选择逻辑来自 [realzza/bilibili-accelerator](https://github.com/realzza/bilibili-accelerator)（MIT）。域名清单参考 blackmatrix7/ios_rule_script 的 BiliBili 规则集。本工程只做 Loon 侧适配，不构成对上游的背书。

本插件不保证任何播放效果，也不替代网络服务质量本身。用了更卡就把插件关掉，插件参数里的「启用换线路」关成 `off` 即退回纯分流。
