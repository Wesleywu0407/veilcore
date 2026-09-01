# Veilcore 視覺資產與效能改善計畫

> 這是暫時性的執行清單。所有項目完成、驗收並合併後，可以刪除本檔案。

## 目標

- 正式決鬥不再用臨時程式幾何充當主要美術效果。
- 使用 Meshy／人工整理後的 GLB，維持目前黑色大教堂、金色玩家與紫色對手的風格。
- 改善畫面時不能犧牲 webcam 手部追蹤、網路同步或遊戲 FPS。
- 保留必須即時變形的程式控制，例如弓弦和飛行軌跡。

## 架構決定：不要全部塞進同一個 JS

可以集中的是「GLB 路徑、載入、快取、複製與共用材質設定」，未來可放在薄薄的 `js/arena/asset-library.js`。

不應集中的是各效果的遊戲行為：

- `js/arena/scene.js`：場地、核心、魔力掉落物。
- `js/arena/spell-system.js`：Aegis、Gravity Seal 的生命週期。
- `js/arena/duelist.js`：角色、手部施法光、IK 附著點。
- `js/arena/bow-view.js`：弓、弓弦、搭弦中的箭。
- `js/arena.js`：射出箭的生命週期、命中與整體流程。

這樣資產只載入一次，但每一種效果仍能獨立調整、測試與關閉。若所有邏輯都放進同一個大型 JS，會更難找出哪個效果造成掉幀。

## 現況

### 已經使用 GLB／Meshy

- [x] 決鬥場：`arena-shell.glb`
- [x] 角色：`sealed-porcelain-duelist.glb`
- [x] 核心神龕：`core-shrine.glb`
- [x] 弓身：`bow.glb`
- [x] Ringfall：`ringfall-halo.glb`
- [x] Aegis：`aegis-barrier.glb`

### 正式決鬥仍使用程式幾何

- [x] 核心八面體與三圈軌道 → `vfx/veil-core.glb`，軌道環整組移除。
- [x] Gravity Seal 圓盤與三個透明光圈 → `vfx/gravity-seal.glb`。
- [x] 手掌施法光球、六片符文碎片與胸前小光圈 → `vfx/hand-focus.glb`；胸前光圈移除。
- [x] 核心被破壞後的魔力碎片 → `vfx/mana-shard.glb`。
- [ ] 搭弦箭與射出箭的外觀 —— 依步驟 5 刻意保留程式幾何。
- [x] 程式角色 fallback 改為只有 Meshy 載入失敗時才建立。

### 應保留程式控制

- [x] 動態弓弦：每幀依拉距改變三個頂點，不能用固定 GLB 取代。
- [x] 箭的移動與命中判定：視覺可以換 GLB，判定仍由純程式邏輯處理。
- [x] HUD、準心、自拍畫面：這些是 Canvas UI，不是 3D 模型。
- [x] 啟動時產生 PMREM 的臨時環境板：建立環境貼圖後已立即 dispose，不是持續的 draw call。

## 效能基準

目前最大的成本不是簡單程式幾何，而是角色模型：

- `sealed-porcelain-duelist.glb`：15.64 MB、約 24,904 三角形、3 張內嵌貼圖約 14.22 MB。
- 場上同時有兩份角色、兩套骨骼動畫；現在只有玩家投射陰影，對手不投射。
- `core-shrine.glb` 約 11,799 三角形，場上複製兩份。
- `arena-shell.glb` 約 15,812 三角形，但只有一個主要 draw call，而且不投射陰影。

資產本身的成本用 `npm run assets` 量（`scripts/glb-info.mjs`）：面數、primitive 數、
貼圖尺寸與格式、下載大小與 VRAM 估算。新的 Meshy 下載先過這一關再接進遊戲。

畫面成本每次替換前後都要在同一台電腦、同一視窗大小測量：

1. 開啟正式決鬥並運行至少 60 秒。
2. 記錄 `window.__arena()` 的 `renderer.calls` 與 `renderer.triangles`。
3. 記錄 canvas 的 `data-fps` 與 `data-quality`。
4. 同時測試一人畫符文、雙手拉弓、對手施法、webcam 自拍畫面與網路對戰。
5. 如果品質 governor 從 `high` 降級，先找出新增資產的成本，不直接放寬門檻。

## Meshy 資產規格

每個即時特效的初始預算：

- 約 1,000–3,000 三角形。
- 儘量一個 mesh、一個 material、一個 draw call。
- 貼圖優先 512 或 1024；只有大型近景物件才使用 2048。
- 特效預設不投射陰影，也不接收陰影。
- 透明／Additive 材質只用在真正需要發光的部分，避免大面積透明層重疊。
- 保留 emissive，但不要依靠大量 PointLight 製造光效。
- 新輸出先使用新檔名驗證，不能直接覆寫現有已修復的 GLB。

## 執行順序

### 0. 建立可比較的基準

- [x] 記錄目前單人決鬥的 FPS、draw calls、三角形數與品質 tier。
- [ ] 記錄雙人 HTTPS 對戰加 webcam 時的相同數字。
- [ ] 保存一張目前效果截圖，讓每次替換可以直接比較。

替換前後在同一視角、同一視窗、同為 `quality: high` 下取樣的單幀數字：

| | draw calls | triangles |
|---|---|---|
| 替換前（commit 1e11952） | 10 | 79,083 |
| 替換後 | 3 | 65,620 |

這是無 webcam 的第三人稱待機視角，含 frustum culling，方向可信但不是穩態平均。
雙人 HTTPS + webcam 的同一組數字仍待實測。

### 1. Gravity Seal

- [x] 用 Meshy／Blender 整理一個低面數封印 GLB —— 2,472 三角形，一張 1024 base color。
- [x] 模型只負責外觀；半徑、持續時間、減速與旋轉仍由 `spell-system.js` 控制。
- [x] 移除舊 CircleGeometry／RingGeometry 前後比較效能。
- [x] 資產載入失敗時退回單一 RingGeometry，避免「減速生效但畫面沒有任何提示」。

### 2. 核心能量體

- [x] 製作能放入現有神龕的單一低面數核心 GLB —— 2,078 三角形。
- [x] 金色與紫色共用同一份幾何，只複製／調色，不下載兩份模型。
- [x] 保留核心禁用、旋轉、碰撞和座標邏輯。
- [x] 確認兩個核心合計沒有明顯增加 draw calls —— 每側一個 mesh，取代原本的八面體加三個環。

### 3. 手掌施法效果

- [x] 將手掌光球與符文碎片換成一個低面數 GLB —— 1,170 三角形，取代原本 7 個 mesh。
- [x] 仍附著在 IK 解出的手腕世界座標。
- [x] 充能、顯示／隱藏和陣營顏色繼續由 `duelist.js` 控制。
- [x] 移除永遠顯示的程式胸前光圈。
- [ ] 需要真實 webcam 才能確認施法時的大小、朝向與旋轉軸看起來對。

### 4. 魔力掉落物

- [x] 製作一個共用的小型碎片 GLB —— 661 三角形。
- [x] 所有掉落物共用 geometry／material；不要每顆重新載入 GLB。
- [x] 維持目前每次噴出四顆、12 秒自動清除的限制。
- [x] 資產缺席時退回八面體，避免出現撿得到卻看不見的掉落物。

### 5. 箭的視覺

**決定：不替換。** 六邊形箭不是效能瓶頸，換掉只會多一個資產與一次載入。

- [x] 只在目前箭的外觀確實不符合美術時才替換 —— 判定為不需要。
- [x] 保留程式弓弦、射線命中與 2.5 秒箭清除機制。
- [x] 不使用高面數 Meshy 箭。

### 6. 角色與陰影最佳化

- [x] 先測量角色貼圖尺寸和實際 GPU／下載成本，再決定是否壓縮。
- [ ] ~~評估角色貼圖降至 2048~~ —— **前提有誤，三張貼圖本來就是 2048。** 真正的選項是換編碼或降到 1024，見下表。
- [ ] 比較「兩位都投射陰影」、「只有玩家投射」與「角色不投射」的 FPS —— 目前直接改成只有玩家投射，三種組合並未實測比較。
- [x] 程式角色 fallback 改為載入失敗時才建立，成功載入時不配置整套代理模型。
- [x] 不直接覆寫 `sealed-porcelain-duelist.glb`；現有 PBR、動畫與 root motion 修復必須保留。
- [x] 角色材質從 MeshPhysicalMaterial 換成 MeshStandardMaterial。

#### 實測的資產成本

以下由 `npm run assets` 產出。VRAM 以 RGBA8 加完整 mip chain 估算（基準層的
4/3）。所有 GLB 都經過 `asset-library.js` 快取，兩位角色共用同一組貼圖，所以每張
只上傳一次。

| 資產 | 檔案 | 三角形 | 貼圖 | VRAM |
|---|---|---|---|---|
| `sealed-porcelain-duelist.glb` | 15.64 MB | 24,904 | 3 × 2048² PNG（14.22 MB） | ~64 MB |
| `core-shrine.glb` | 3.97 MB | 11,799 | 1 × 2048² JPEG | ~21 MB |
| `bow.glb` | 3.29 MB | 8,945 | 1 × 2048² JPEG | ~21 MB |
| `arena-shell.glb` | 1.01 MB | 15,812 | 1 × 1024² JPEG | ~5 MB |
| `ringfall-halo.glb` | 0.45 MB | 4,920 | 1 × 1024² JPEG | ~5 MB |
| `vfx/gravity-seal.glb` | 0.41 MB | 2,472 | 1 × 1024² JPEG | ~5 MB |
| `aegis-barrier.glb` | 0.23 MB | 3,264 | 1 × 512² JPEG | ~1 MB |
| `vfx/veil-core.glb` | 38 KB | 2,078 | 無 | — |
| `vfx/hand-focus.glb` | 22 KB | 1,170 | 無 | — |
| `vfx/mana-shard.glb` | 13 KB | 661 | 無 | — |

角色貼圖是 **PNG**，佔了那 15.64 MB 裡的 14.22 MB。這是下載時間的問題，不是幀率
的問題：貼圖總量約 122 MB VRAM，在任何一張真實顯卡上都不會掉幀。

#### 兩件 Meshy 留下的怪東西

`baseColorTexture` 與 `emissiveTexture` 指向**同一張 2048² 圖**，而
`emissiveFactor` 是 `[1,1,1]`——角色等於用自己的 albedo 全亮度自發光，月光與 IBL
幾乎塑造不了它。three.js 會把兩者去重成同一個 Texture，所以不浪費 VRAM，但這是
目前角色長相的主要來源。要不要改是美術決定，不是效能決定。

`KHR_materials_specular` 的 `specularColorFactor` 是 `[2,2,2]`，超出合法範圍。
它連同 `KHR_materials_ior` 就是 GLTFLoader 選擇 MeshPhysicalMaterial 的原因。

#### 幀率真正的槓桿（尚未動，都會改變外觀）

1. `PCFSoftShadowMap` → `PCFShadowMap`：每個受影表面少掉數次取樣，而整片地板都
   受影。1024² 陰影圖下視覺差異很小。
2. 兩盞 `PointLight`（`playerGlow`／`opponentGlow`）：每個 fragment 各多一次完整
   光照計算。本檔的 Meshy 規格本來就寫「不要依靠大量 PointLight 製造光效」。
3. `setPixelRatio` 上限 1.25 加 `antialias: true`：這是每幀最大的一筆，但品質
   governor 已經在管它。

這三項都會動到畫面的感覺，依 AGENTS.md §5 不該由我私自調——需要 Wesley 在螢幕前
看過再決定。

### 7. 清理與最終驗收

- [x] 確認 `js/spells/beam.js` 和 `js/arena/targets.js` 仍然沒有引用後，再分開刪除。
- [x] 執行 `npm run test`，所有測試必須通過 —— 80/80。
- [ ] 執行符文、弓、自拍 webcam、單人 bot 與雙人 HTTPS 對戰的人工測試 —— 需要真實相機，只能在本機手動跑。
- [x] 與步驟 0 的基準比較；不能因美術替換造成持續品質降級 —— 單人待機視角已比較，雙人 webcam 場景待測。
- [x] 更新 README 的資產來源、模型處理與效能預算。
- [ ] 所有項目完成並合併後刪除 `PLAN.md`。

## 完成定義

- 正式決鬥的主要可見場景、角色與法術外觀皆來自經最佳化的資產。
- 動態弓弦、命中、動畫、IK、HUD 和網路同步仍由原本模組負責。
- 同一場景下的 FPS 不低於基準，品質 governor 不會因新資產長時間降級。
- 沒有在每幀建立新的 geometry、material、texture 或 GLBLoader。
- 所有測試通過，雙人 HTTPS webcam 對戰可以完整打一局。
