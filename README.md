# ele-percy-demo

验证 ele-percy 发版门禁的最小演示：一个静态页面 + 一张 Playwright 视觉快照 + 测试结果上报。

```bash
npm install && npx playwright install chromium
PERCY_TOKEN=<项目 token> PERCY_CLIENT_API_URL=<ele-percy>/api/percy/v1 \
PERCY_BRANCH=<分支> PERCY_COMMIT=<commit sha> npm run e2e:visual
```
