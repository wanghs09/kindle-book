#!/usr/bin/env bash
# 一键发布到 GitHub：创建仓库（若不存在）、推送 main 与 tag、创建 Release。
#
# 用法：
#   scripts/publish.sh                          # 默认 wanghs09/dsh-plugin-kindle-book
#   scripts/publish.sh owner/repo               # 指定仓库
#   HTTPS_PROXY=http://127.0.0.1:8118 scripts/publish.sh   # 走本地代理
#
# 前置：gh 已登录（gh auth login）。脚本不会替你登录，也不会保存任何凭据。
set -euo pipefail

REPO="${1:-wanghs09/dsh-plugin-kindle-book}"
VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"

if [[ -n "${HTTPS_PROXY:-}" ]]; then
  export https_proxy="$HTTPS_PROXY"
  export http_proxy="${HTTP_PROXY:-$HTTPS_PROXY}"
  git config --local http.proxy "$HTTPS_PROXY"
  echo "· 使用代理 $HTTPS_PROXY"
fi

if ! gh auth status >/dev/null 2>&1; then
  cat <<'EOF'
✗ gh 未登录，先执行：
    gh auth login -h github.com
  （或设置 GH_TOKEN=<你的 PAT> 后重跑本脚本）
EOF
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ 工作区有未提交改动，先提交再发布" >&2
  exit 1
fi

echo "· 目标仓库 $REPO，版本 $TAG"

# 让 git 用 gh 的凭据推送（幂等；只改本机 git 配置）
gh auth setup-git --hostname github.com

if gh repo view "$REPO" >/dev/null 2>&1; then
  echo "· 仓库已存在，直接推送"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/${REPO}.git"
  git push -u origin HEAD:main
  git push origin "$TAG" 2>/dev/null || git push origin --tags
else
  echo "· 创建仓库并推送"
  gh repo create "$REPO" --public --source . --remote origin --push \
    --description "$(node -p "require('./package.json').description")"
fi

if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  echo "· Release $TAG 已存在，跳过"
else
  echo "· 创建 Release $TAG"
  gh release create "$TAG" -R "$REPO" --title "$TAG" --generate-notes
fi

cat <<EOF

✓ 发布完成

  仓库      https://github.com/${REPO}
  安装      git+https://github.com/${REPO}.git
  npm       $(node -p "require('./package.json').name")（若已 npm publish）
  市场索引  https://raw.githubusercontent.com/${REPO}/main/market-index.json

  记得把新的 commit 写进 market-index.json 的 source.commit，并更新 README 里的徽章/链接。
EOF
