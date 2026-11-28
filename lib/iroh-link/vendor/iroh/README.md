# vendor/iroh — dumbpipe（iroh TCP 承载）

`dsh-team-mesh` 的 iroh 承载只依赖 n0-computer 的 `dumbpipe` 可执行文件，不引入
任何 JS 依赖。这里放的是**原样转载**的上游二进制与许可证，没有改过一行。

| 项 | 值 |
| --- | --- |
| 上游 | https://github.com/n0-computer/dumbpipe |
| 版本 | v0.40.2（2026-11-19 发布） |
| 平台 | windows-x86_64（本目录的 `dumbpipe.exe`） |
| 下载 | https://github.com/n0-computer/dumbpipe/releases/download/v0.40.2/dumbpipe-v0.40.2-windows-x86_64.zip |
| SHA-256 | `7d6edef3f30c98499c36166748f7190a93ed74a2be4e01fe9daa889730d05c6f` |
| 许可 | 双许可 MIT OR Apache-2.0（见 `LICENSE-MIT` / `LICENSE-APACHE`） |

其他平台：从同一 release 页面取对应包，把可执行文件放到 `vendor/iroh/dumbpipe`
（Linux/macOS）或在配置里用 `irohLink.binaryPath` 指向别处。

校验：

```powershell
(Get-FileHash .\vendor\iroh\dumbpipe.exe -Algorithm SHA256).Hash.ToLower()
```

注意：本目录的二进制不进 git（见 `.gitignore`），换机器时按上表重新取。
