# 图标说明

图标文件为二进制 PNG，无法随代码生成，请手动放置两个同名文件到本目录：

- `icon-192.png` —— 192x192 像素
- `icon-512.png` —— 512x512 像素

`manifest.json` 与 `index.html`（apple-touch-icon）已按相对路径 `./icons/icon-192.png` 和 `./icons/icon-512.png` 引用它们。

## 制作方式（任选其一）

1. 用任意绘图工具（Figma / Sketch / 画图等）画一个简单的黑白图标，导出上述两种尺寸。
2. 使用在线工具（如 https://realfavicongenerator.net/ 或任意 PWA icon 生成器）从一张 512x512 底图批量生成。
3. 命令行（需安装 ImageMagick）：

```bash
magick icon-512.png -resize 192x192 icon-192.png
```

> 提示：文件名和尺寸必须与上面完全一致，否则 PWA 安装时图标会缺失。
