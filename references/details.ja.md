# HyperFusion 詳細説明

[English](details.en.md) | [한국어](details.md) | 日本語

短い紹介は [README](../README.ja.md) にあります。このページでは、全機能、設定、セキュリティ、テストの制約をまとめています。

## 特徴

### 配置とチーム

- **チーム編成 → 承認 → マイルストーン → チェックポイント。** 企画書を読んだリードが担当を割り当てたチーム案を提示し、承認前には作業を始めません。`project.mjs draft` が導入済みのメンバーで案を埋め、未導入のメンバーは拒否します。マイルストーンが終わると報告し、確認を得てから次へ進みます。`project.mjs schedule` はタスクの依存関係を固定計画として管理します（実装は直列のままです）。→ [project](project.md)（韓国語）· [作業計画](workflow-plan.md)（英語）
- **能力ベースの割り当て。** 名前ではなく能力（`caps`：`code`、`ui`、`docs`、`image-gen` …）で候補を絞り、自分のリポジトリでの実績（差し戻し率）で順番を決めます。実績のないワーカーにも、ときどき探索枠として先に任せます。既存アダプターのモデル ID と能力は `executors` で変更でき、新しいプロバイダーには別途アダプターの実装が必要です。→ [routing](routing.md)（韓国語）
- **導入チェックと契約スモークテスト。** `setup-doctor.mjs` は設定を変更せずに、インストール済みの CLI に合うプリセットを提案します。`--smoke` は一時リポジトリで各ワーカーに小さな実作業を任せ、CLI 更新後もフラグ・出力形式・結果契約が通るかを確かめます。導入チェックは認証や残量の検証ではありません。→ [operations](operations.md#doctor-계약-스모크)（韓国語）
- **External-First 配置。** A 級・B 級のワーカーはすべて自動実装の候補となり、等級ごとに割り当てられます。grant が必要なのは Sol（APEX ラウンド）だけで、自動フォールバックや探索枠で Sol は選ばれません。B 級のラウンドが差し戻された場合は A 級へ回します。適応型レビュー（`lead-gated-adaptive`）を有効にすると、既定で `routing.policy: "external-first"` になり、classic 配置も同じ等級表を使います。

### 検証とレビュー

- **ワーカーの主張を鵜呑みにしない。** 変更ファイルやテスト合格の申告は、スナップショット差分とコントローラによる再実行でのみ認めます。事実と異なる申告は復旧フェーズへ回します。
- **具体的な差し戻し。** 差し戻しには理由と受け入れ基準 ID（`AC1`、`AC2` …）が必須で、再指示にはファイル・行単位の指示書が要ります。同じ基準で 2 回差し戻されたワーカーは交代させます。通常ワーカーは各 3 ラウンドまで、リードによる takeover は利用可能なワーカーがすべて尽きた後の 1 回だけです。
- **静的チェックの関門。** 作業指示書の `static_commands`（リント、型チェック）を、コントローラが finish と `VERIFY` で自ら実行します。受け入れテストとは逆に、作業前のベースラインで通ることが条件です。失敗した場合はレビューへ進まず同じワーカーへ戻します。ワーカーがルールを無効化できないよう、`static_protect` に挙げた設定ファイルが変わった場合は実行せずリードへエスカレーションします。通過するまで作業は閉じられません（`STATIC_NOT_PASSING`）。→ [static-gate](static-gate.md)（韓国語）
- **red-first の受け入れテスト。** コントローラが受け入れコマンドを自ら実行し、開始時に手を加えていないツリーで失敗することを先に確認して、最初から通ってしまう形だけの関門を防ぎます。リファクタリングのように最初から通るのが正しい作業では、**保存検証**（`verification: {kind: "preserve", protect: [...]}`）を使い、保護対象のテストやフィクスチャが作業中に変わっていないことをスナップショットで証明します。
- **AC 追跡表と PR 下書き。** `acceptance_map` で受け入れ基準（`AC1` …）とそれを証明するコマンドを結びます。完了時には AC 別の判定表と PR 説明の下書き（`pr-draft.md`）を残します。変更一覧は最初のワーカー開始時（`base-1`）からの最終的な累積差分で、検証済みラウンドに帰属しないファイルは `unattributed_changes` として別に示します。コミットとプッシュはユーザーの指示で行います。
- **独立したレビュー委任。** ラウンドのレビューは Sol など別のモデルが読み取り専用で担います。レビュアーには累積差分（最大 100,000 文字）とコントローラが実行した受け入れ結果を渡し、ワーカーの要約・テスト報告や他のレビュアーの結論は渡しません。実装したモデル自身はレビューできず、ファイル・行の根拠がない差し戻しはそのまま適用しません。→ [review](review-protocol.md)（韓国語）
- **指摘台帳とリードの対応判定。** レビューの指摘を原証拠とともに記録し（`findings`）、リードが指摘ごとに対応区分（disposition）と理由を残します。次のラウンドには `@findings` で受け入れた指摘だけを渡し、対応記録はレビュアー別の実効性指標になります。表示をまとめても、原証拠と必須レビューは維持されます。→ [指摘台帳](finding-ledger.md)（英語）
- **相談（advisor / committee）。** ワーカー 1 名（advisor）が先に差分を点検するか、2 名（committee）が繰り返す失敗の原因を調査します。読み取り専用で、前後のスナップショット比較によって保証します（同時実行は最大 2 スロット）。→ [consult](consult.md)（韓国語）· [読み取り専用作業](read-only-work.md)（英語）
- **ラウンド間の変更検出。** 後続の `begin` は現在のツリーを直前の `post_digest` と比較します。スコープ内のファイルを Bash で書き換えた場合も、不一致があれば lease や試行予算を消費する前に `RECOVERY_REQUIRED` で止めます。復旧で保持した変更は累積レビューの対象になりますが、ワーカーの実績や自動承認にはなりません。最初の `begin` より前にあったユーザーの変更は保持します。→ [recovery](recovery-protocol.md)（韓国語）

### リードの負担軽減

- **簡潔な出力と `next`。** CLI 出力の既定は compact 表示です（全項目は `--full`）。`next` は現在のフェーズで実行するコマンド 1 行と、token や digest のようにコントローラが把握している値を埋めた入力テンプレートを返します。
- **診断と再開。** 読み取り専用の `diagnose` が停止理由を固定コードで示し、`resume` が中断した作業の次の一手を出します。整合性の調整（`reconcile`）は `init` で明示的に許可した場合だけ実行します。→ [再開・整合性調整](reconciliation.md)（英語）
- **タスク単位の委任（オプトイン）。** リードが `init` で `delegation` を許可すると、コントローラは条件をすべて満たした `STANDARD` ラウンドを自動承認し（`delegated-policy` として記録）、ファイル変更なしで終わった一時障害のワーカー実行を再試行し、完了できなかったレビュアーを別ベンダーのモデルへ差し替えます。条件が 1 つでも欠けていればリードゲートで止まります。→ [universal-supervisor](universal-supervisor.md#위임-승인-재량권)（韓国語）
- **オートパイロット。** 記録されたゲートと予算の範囲内で、ラウンド実行と独立した委任レビューを自動で進めます（下の[インストールと使い方](#インストールと使い方)を参照）。`report.lead_load` では、リードが直接判定した回数、ポリシー承認された回数、リードが読む必要のあったゲート数、自動・手動復旧の回数を確認できます。
- **コンパクション後の再開。** リードガードの `SessionStart` フックが、新しいセッションの開始時や会話の要約後に進行中の作業と次のコマンドを 1 回だけ通知します。
- **作業状態の 1 行表示。** `fusion-state.mjs line`、`UserPromptSubmit` フック、プロンプト上部のステータス表示（`mods/hf-status`）が、フェーズ・ワーカーのラウンド・次の操作を同じ 1 行で表示します。→ [運用説明](operations.md#작업-상태-표시)（韓国語）
- **ルール候補の抽出。** `memory.mjs rule-candidates` は、異なる 2 つ以上のタスクで繰り返された `error` 記憶を機械チェック化の候補として読み取り専用で一覧表示します。リードがルールファイルへ移した記憶は想起から外れ、そのファイルが変更または削除されると再び候補に上がります。→ [static-gate](static-gate.md)（韓国語）
- **ローカルメモリ。** エラー・手順・経験から得た承認済みの知見を外部サーバーなしでローカルに蓄積し、次のセッションや他のワーカーへ引き継ぎます。書き込みと想起はいずれもリードの承認を経て出典・バージョンで絞り込み、秘密情報に似た文字列は拒否します。→ [memory](memory.md)（韓国語）· [メモリ検索](memory-recall.md)（英語）
- **通知。** `HF_NOTIFY_URL`（ntfy など）を設定すると、ワーカー完了時やリードの判断が必要なときに状態のみのプッシュ通知を送ります。

### 制御と監査

- **単一ライターと監査記録。** ファイルを編集できるのは同時に 1 つのワーカーだけで、ラウンドごとにスナップショットと成果物が残ります。中断しても復旧手順から再開でき、自動の commit・push・デプロイは行いません。
- **リードガードフック。** ワーカーが lease を保持している間や予算が残っている間は、リードの `Edit`/`Write` と書き込み可能な MCP ツールをブロックし（`PreToolUse`）、リードの手番を残したままターンを終えようとすると一度止めます（`Stop`）。Bash での書き込みはフックではなく、スナップショットとラウンド間の差分検査で検出します。→ [operations](operations.md#리드-가드-훅)（韓国語）
- **独立 worktree と作業上限。** 独立したタスクは別々の worktree で状態とライター lease を分離して動かし、報告された費用と経過時間に上限を設けます。結果は個別にレビューしたあと統合します。→ [並列実行と上限](operations.md)（韓国語）
- **共通ローカル監視。** すべての `implement`/`review`/`consult` 呼び出しを同じ supervisor が観測します（`status --monitor`、`monitor --once|--watch`）。無信号は `QUIET` 警告にとどまり、架空の進捗や成功を出しません。監視自体はモデルを呼び出しません。
- **Linux・macOS・Windows 対応。** CI は Ubuntu と Windows で動作します。

## 適応型レビュー（オプトイン）

レビュー戦略を `lead-gated-adaptive` にすると、下記のレビュー規則と最終リードゲートが適用され、自動実装の割り当ては External-First になります。Claude と Codex の導入時に `setup-doctor` が勧めるプリセット（`claude-codex`、`external-first`）と `hyperfusion.v03.config.example.json` がこの戦略を使います。既存の classic 設定と実行中のタスクは自動変更されません。→ [universal-supervisor](universal-supervisor.md)（韓国語）

- **作成者別のレビュー。** 通常タスクは独立レビュアー 1 名、重要タスク・明示的な二重レビュー・リスクパスの変更は下表のペアが独立して並列に検証します。実装者が自分のラウンドをレビューすることはできません。差し替えには記録された理由が要り、既存の差し戻しは別の `PASS` で消えません。意見の衝突や結果の欠落はリードゲートに残ります。従来の割り当てと承認済みの Grok なしチームは以前の規則を保ちます。
- **最終リードゲート。** 結果は `LEAD_DECISION_REQUIRED` で止まります。`auto_apply`、レビュー採用、オートパイロットでは飛ばせず、タスク単位の明示的な `delegation` 許可がある場合にのみポリシー承認が可能になります（未帰属の変更があると自動承認されません）。

| 実装者 | 重要・二重・リスクパス用レビューペア |
|---|---|
| Grok | Sol `xhigh` + Sonnet `max` |
| Luna / Terra | Sonnet `max` + Grok `xhigh` |
| AGY / Haiku / Sonnet | Sol `xhigh` + Grok `xhigh` |
| 承認済み APEX Sol | ペア委任ではなくリードの直接レビュー |

リードは `init` の承認済み指示書で重要度と戦略を決め、`review_preview` を確認します。根拠のある全員 `NG` に限り、`init` で許可された `redo_delegation` を使って再作業に戻せます。意見が割れた場合はリードが判断し、全員 `PASS` でも別途適格な承認委任がなければリードへ報告します。ホストのモデル名は認証できないため、`authority.model_verified: false` として記録します。→ [詳細ルール](review-pairs.md)（英語）

## ベンダー・モデル設定

- **AGY モデル系統と推論強度。** `executors.antigravity.model: "gemini-4-argon"` と `reasoning_effort: "high"` を別々に指定すると `gemini-4-argon-high` を選びます。接尾辞で強度を固定したモデルはそのまま維持され、矛盾する `reasoning_effort` は起動前に拒否されます。解決されたスラッグは `agy models` で照合し、利用できない組み合わせを別モデルへ勝手に差し替えません。→ [設定](configuration.md#agy-모델-계열과-effort-분리-argon)（韓国語）
- **Codex。** JSONL の thread・turn 使用量を記録し、互換性のある `exec resume` フラグを確認できた場合のみ、タスク単位の実装セッションを正確な ID で再開します。レビューは毎回新しい読み取り専用セッションで実行します。運用者専用のビルドキャッシュ・ネットワーク設定と Claude/Grok のターン上限は [Codex 運用案内](codex-runtime.md)（英語）を参照してください。
- **ベンダー制限。** `allowed_vendors: ["anthropic", "openai"]` は実装・レビュー・相談をまとめて制限し、運用者の `HF_ALLOWED_VENDORS` はリポジトリ設定で広げられない上限として働きます。ブリッジは起動直前に再検査します。ただしファイアウォール・DLP やベンダー認証ではなく、新 CLI の追加には検証済みアダプターの実装が必要です（`scripts/member-registry.mjs`）。
- **既定の推論強度。** 実装の既定は Terra `medium`、Grok `high`、Sonnet `medium`、Luna `xhigh`、Haiku `max`、Antigravity Gemini 4 Hydrogen `high` です。レビュー席は Sol `xhigh`、Sonnet `max`、Grok `xhigh` で、実装の推論強度とは別管理です。`reasoning_effort: null` は通常フラグの省略を意味し、必須レビュー役の推論強度は解除しません。

## 測定

- **リードの使用量。** 生成されたフックが `Stop`、`SessionEnd`、`StopFailure` のタイミングでローカル Claude Code トランスクリプトからモデル別の実使用量を収集します。証拠がなければ未測定とし、明示的な `TASK_USAGE.json` の観測を優先します。値はクライアント報告値であり、課金 API ではありません。→ [指標ポリシー](metrics-policy.md)（韓国語）
- **ベンチマーク。** `benchmark.mjs cases` は固定パイロット課題を、`compare BASELINE.json HYPERFUSION.json` は実測のペア指標を比較します。失敗タスクのコストも分子に含め、ペアの欠落や未測定があれば削減率を出しません。`--suite large` は実際の機能コミットから作った課題を選び、2 回ずつ実行した結果は [README](../README.ja.md#測定結果) に載せています。→ [反復ベンチマーク](benchmark-pilot.md)（英語）
- **使用量の計測とクォータ。** 実装・レビュー・相談・失敗呼び出しおよび APEX Sol を含めて記録し、未計測の値は `null` に保ちます。クォータは `scripts/quota-policy.mjs` で運用者が直接記録する（`record`）か、Codex のセッション記録から `rate_limits` を読み取ります（`collect-codex`、ネットワークもモデルも使いません）。出所不明または有効期限切れの記録は「不明」として扱います。

## セキュリティ

これらの仕組みは**協業のための統制であり、OS のサンドボックスではありません**。

- 制御ファイル（状態、指示書、スナップショット）は作業フォルダの外 `~/.hyperfusion/state/` に置きます（`HF_STATE_DIR` で変更可能）。ワーカーが自分でスコープを広げることはできません。
- スナップショットは Git の設定とフック、リンク worktree 専用の `config.worktree`、`.env`、自身を無視する `.gitignore`、`node_modules/.bin`、`agy` の作業フォルダ（`.agents/`、`.agent/`、`_agents/`、`_agent/`）まで監視します。コントローラの Git は呼び出し直前に include・条件付き include・worktree を含む有効設定を読み直し、実行可能なドライバーを無効化します。設定を読めなければ `GIT_CONFIG_UNREADABLE` で停止します。
- ブリッジは起動直前にリクエストを再構築して検証し、ワーカーに必要な環境変数だけを渡します。
- Bash の許可ルールはテスト・リント・ビルドに限ったコマンド形状だけを受け付けます。実装サンドボックスの無効化など制約の緩和は、リポジトリ設定ではなく運用者の環境変数でのみ有効にします。→ [configuration](configuration.md#보안-관련-환경변수)（韓国語）
- 読み取り専用の相談・レビューは、ツールのサンドボックスではなく前後のスナップショット比較で保証します（違反した回答は破棄します）。Antigravity の `--sandbox` はターミナルだけを制限し、ファイル書き込みツールは止められません。

シェルを使えるワーカーは作業フォルダ外のファイルにもアクセスでき、スナップショット比較はリポジトリ外への書き込みを検知できません。すでに無視されている通常の依存ファイル（例：`node_modules/dep/index.js`）の内容変更はスナップショットでハッシュ監視しませんが、コントローラが受け入れテストを実行する前に無視ファイルのメタデータを比較し、変更があれば明示的な対処がない限り実行を止めます。→ [operations](operations.md#수용-테스트-자동-실행)（韓国語）

旧バージョンで作業フォルダ内に制御ファイルを置いていた環境は `fusion-state.mjs migrate <リポジトリ>` で移行します。互換性のない保存スキーマについては [configuration](configuration.md)（韓国語）と [recovery](recovery-protocol.md)（韓国語）のアーカイブ手順に従ってください。

## インストールと使い方

必要なもの：Node.js 24+、`git config --show-scope --includes` に対応した Git、**初期コミットのある Git リポジトリ**（リモートなしのローカル専用でも可）、インストール・認証済みの `claude`、`grok`、`agy`、`codex` のいずれか 1 つ以上。

```sh
# Linux / macOS
git clone https://github.com/prentice7725/hyperfusion.git ~/.claude/skills/hyperfusion
```

```powershell
# Windows (PowerShell)
git clone https://github.com/prentice7725/hyperfusion.git "$env:USERPROFILE\.claude\skills\hyperfusion"
```

Claude Code で Opus 5.5 を選び、次のように実行します。

```text
/hyperfusion <作業内容>
/hyperfusion --executor sonnet <作業内容>
```

リードは [SKILL.md](../SKILL.md)（英語）に従ってコントローラとブリッジを呼び出します。まずスキルディレクトリから `node scripts/setup-doctor.mjs <リポジトリ>` を実行して CLI の導入状況を点検してください。リポジトリ設定は対象リポジトリの `hyperfusion.config.json`（例：`hyperfusion.config.example.json`）に置きます。

### リードガードフック

スキルディレクトリで `npm run guard:settings` を実行すると、このマシンの絶対パスを用いたフック設定（`PreToolUse`、`Stop`、`SessionStart`、`UserPromptSubmit`、`PreModelSwitch`、`PostModelSwitch`、`SessionEnd`、`StopFailure`）が出力されます。ブロック系のガードコマンドには `onFailure: "block"`（Claude Code v2.1.295 以降）が付いており、ガードが異常終了したりタイムアウトしたりしてもツール呼び出しを止めます。出力された `hooks` を `~/.claude/settings.json`（または対象リポジトリの `.claude/settings.json`）にマージしてください。既存環境を更新する場合も、新しい使用量収集コマンド、MCP ツールガード（`mcp__.*`）、モデル切り替えフックを取り込みつつ、他のフックを保持しコマンドの重複を避けてください。

### オートパイロット

初期化済みのタスクでは `node scripts/fusion-state.mjs autopilot <リポジトリ>` を使ってラウンド実行と独立した委任レビューを自動進行できます。次の条件を満たしていれば、難易度にかかわらず `next` が最初のラウンドにこのコマンドを勧めます。

- リードが定めた `acceptance_commands` があり、ベースラインツリーで失敗（`red`）が確認されていること（`preserve` 検証では逆に、事前通過が確認されている必要があります）。
- classic レビューでは `review.auto_apply: true` も必要です（`lead-gated-adaptive` はいずれにしてもリードゲートで止まるため不要です）。

`VERIFY`、設計判断、復旧、`BLOCKED`、takeover ではリードへ制御が戻り、プロセス停止・スナップショット・予算・検証の確認に失敗した場合も停止します。リードが `delegation` を許可したタスクでは、コントローラが承認したラウンドの検証から完了まで進めます。→ [運用説明](operations.md#오토파일럿)（韓国語）

### 終了証明と外部送信マスキング

受け入れテストでも子プロセスの終了を確認します。終了の証拠がなければ `RECOVERY_REQUIRED` で止まり、リードによる停止確認を待ちます。タスクの経過時間上限は受け入れテストと最終検証にも適用されます。

外部へ送る指示書・差分・過去の結果には、メール・IP・API キー・パスワードに加え、韓国と日本の個人識別番号（マイナンバー、住民登録番号・外国人登録番号、電話、カード、銀行口座、旅券、運転免許証、在留カード、基礎年金番号）のパターンマスキングが既定で適用されます。認証に必要なベンダー環境変数は維持されます。CLI が直接読み取って送信するリポジトリ内のファイルまで防ぐ DLP ではないため、社内コードではファイルアクセスと外部送信のポリシーも別途管理してください。→ [送信範囲](operations.md#외부-전송-마스킹)（韓国語）

## テストと制約

```sh
npm test
```

自動テストでは、状態機械、ワーカーアダプター、配置、レビュー委任、タスク委任と自動復旧、ローカルメモリ、プロジェクト進行、セキュリティ、マスキング、オートパイロットを検証します。実 CLI を使うスモークテスト 1 件は `HF_LIVE=1` のときだけ実行します。GitHub Actions は Ubuntu・Windows × Node 24 で実行する構成です。Windows ではテストファイルを順次実行するため（1 台で全件回すと数時間かかります）、CI では Windows ジョブを 4 台のランナーに分割し（`HF_TEST_SHARD`、他 OS は並列度 2）、実際に孤児プロセスを作る回帰テストは並列テストの後に別途実行します。

**テスト内の `grok`、`agy`、`claude`、`codex` はモック CLI です。** 実モデルの品質、認証、画像生成はリポジトリのテストでは検証されません。インストール済みの CLI に必要なフラグが欠けている場合は、実行前に `ADAPTER_UNAVAILABLE` で拒否します。アダプターのフラグは [Grok Build](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)、[Antigravity CLI](https://antigravity.google/docs/cli/headless)、[Claude Code](https://code.claude.com/docs/en/headless) のドキュメントに基づいています。一時障害の自動復旧判定もモック CLI を基準にしているため、実 CLI では最初の数回、`recovery-*.json` の `reason` を確認することをおすすめします。実モデルで測定したリードトークンの結果は [README](../README.ja.md#測定結果) にあります。

## ライセンス

MIT。[LICENSE](../LICENSE) を参照してください。
