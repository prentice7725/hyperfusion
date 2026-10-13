# HyperFusion

[English](README.md) | [한국어](README.ko.md) | 日本語

**Claude Opus 5.5は指示と検収だけを行い、コードは他のモデルが書きます。** 実装とテストをSonnet・Haiku・Grok・Antigravity・Lunaに任せ、レビューはSolに任せることもできるClaude Codeスキルです。

> **バージョン。** パッケージのリリースは`0.21.0`（`package.json`）です。**v0.3**はその上に載せた運用プロファイル（External-First＋共通監視）の名前で、保存スキーマ4、アーキテクチャ識別子`opus-lead-v0.3`、wire protocol `hyperfusion-opus-lead-v0.5`はパッケージバージョンとは別の互換性識別子です（正本は`scripts/versions.mjs`）。バージョンごとの変更は[CHANGELOG（韓国語）](CHANGELOG.md)を参照してください。

## 作った理由

1. **トークン節約。** 高価なモデル（Opus）がコードを書き、テストを回し、ログを読むのにトークンを使うのは無駄です。Opusは計画・差し戻し・最終検収だけを行い、実装とテストの反復はより安いモデルや別サブスクリプションのモデルが担当します。成功した作業あたりのOpusトークンを主要指標として計測し記録します。
2. **相手にするのはリードだけ。** 複数のエージェントを一画面で管理するツールはすでにあります。このスキルは逆に、ユーザーが**Opus一人だけを相手にし、ワーカーの管理はOpusが行います。** ワーカーの「完了しました」は信用せず、空の差し戻しは許さず、具体的な指示書で詰め、同じミスを2回したら別のワーカーに交代させます。

## 使用量の測定とインストール済みチーム (0.21.0)

生成したフックがホストセッションを結び付け、Stop/SessionEnd/StopFailure時にローカルClaude Code transcriptのassistant使用量を自動収集します。実際のモデルごとにinput・output・cache read・cache creationを集計し、ストリーミングの重複メッセージや再開したセッションは一度だけ数えます。終了後最初のStopの最終報告まで含め、その後のプロンプトでは測定区間を延長しません。証拠がなければ未測定とし、明示的な`TASK_USAGE.json`の観測を優先します。クライアントの報告値であり、課金APIではありません。→ [指標ポリシー](references/metrics-policy.md)

`node scripts/project.mjs draft REPO`（または`roster REPO --draft`）は、インストール済みチームと未導入メンバーの`excluded`理由を埋めた案を返します。構成案の提出・承認は未導入メンバーを拒否します。`setup-doctor.mjs`は設定変更や承認をせずプリセットを推薦します。Claude+Codexだけの環境の`claude-codex`プリセットはlowをLuna、medium/highの画像以外の作業をSonnetに割り当て、Sol/Sonnetが相互レビューします。プロジェクトのユーザー承認がコントローラによるSonnet実装grantを許可し、明示的な割り当ては維持されます。導入確認は認証や残量の検証ではありません。

`node scripts/benchmark.mjs cases`は固定パイロット課題10件を表示します。`node scripts/benchmark.mjs compare BASELINE.json HYPERFUSION.json`は`case_id`、明示的な`success`、ホスト使用量とClaude合計トークンを含む実測のペア配列を比較します。失敗のコストも分子に入れ、ペア欠落・未測定・測定区間の不一致があれば削減率を出しません。モデル呼び出しは行いません。実モデルのパイロットは未実施なので、削減効果は主張しません。


## チーム

| メンバー | モデル | 基本の役割 |
|---|---|---|
| **Opus（リード）** | claude-opus-5-5 | チーム編成、計画、差し戻し、最終検収。ワーカーが残っている限りコードは書かない |
| Sonnet | claude-sonnet-5-5 | 中・高難度のコード、テスト、リファクタ |
| Haiku | claude-haiku-5-5 | 易しいコード、ドキュメント、テスト補強（Sonnetと同じClaude Code CLI） |
| Grok | Grok CLI | 画像アセット、易しい実装 |
| Antigravity | agy | UI・フロントエンド、ドキュメント（画像生成機能なし） |
| Luna | gpt-6-luna（Codex） | 小規模な修正、機械的な大量編集、画像アセットの補助 |
| Sol | gpt-6.1-sol（Codex） | 通常はレビュー・委員会相談。v0.3のAPEX承認ラウンドでのみ実装可能 |

基本の配置は出発点です。プロジェクトごとにリードが変更し、種類・難易度別の実績に時間減衰と再探索を適用して配置を調整します。未インストールのワーカーは飛ばされます。実行前のCLI確認が一時的に失敗しても試行予算を消費せず再試行できます。担当ワーカーの実行ファイルがなくなった場合は別のワーカーに交代できます。

## 一つの作業の流れ

```text
リード: 計画（brief＋受け入れコマンド）→ init → begin
ワーカー: 単一writerとして実装 → 結果を報告
コントローラ: finish（スナップショットdiff、受け入れテストの直接実行、プロセス停止の確認）
レビュー: 実装していない別のモデルが読み取り専用で検討
リード: 判定（pass / redo / alternative / decision / takeover）→ verify → CLOSE
```

CLOSEまで到達して初めて成功です。どの段階でも、次に打つコマンドは`node scripts/fusion-state.mjs next <リポジトリ>`が教えてくれます。

## 特徴

**配置とチーム**

- **チーム編成 → 承認 → マイルストーン → チェックポイント。** 企画書を読んだリードが担当を決めたチームを報告し、承認前は作業が始まりません。マイルストーンが終わると報告し、確認を受けてから次へ進みます。→ [project](references/project.md)
- **能力ベースの配置。** 名前ではなく能力（`caps`：code、ui、docs、image-gen…）で候補を絞り、自分のリポジトリでの実績（差し戻し率）で順番を決めます。既存アダプターのモデルID・能力は設定で変更できます。新しい提供元には別途アダプターの実装が必要です。実績のない新人にはときどき先に任せます。→ [routing](references/routing.md)
- **契約スモーク。** `setup-doctor.mjs --smoke`がワーカーごとに一時リポジトリで小さな作業を実際に任せ、CLIフラグ・出力形式・結果契約が合っているか確かめます。CLI更新後に誰が壊れたかすぐ分かります。→ [operations](references/operations.md#doctor-계약-스모크)

**ワーカーを信用せず確認する**

- **ワーカーの言葉は信用しない。** 変更ファイルやテスト合格の主張は、スナップショットdiffとコントローラの再実行でのみ認めます。虚偽の申告は復旧段階に回されます。
- **厳格な差し戻し。** 差し戻しには理由が必須で、再指示にはファイル・行単位の指示書が必須です。同じ受け入れ基準（AC1…）で2回差し戻されたらワーカーを交代します。ワーカーあたり3ラウンド、リードのtakeoverは全ワーカーが尽きた後の1回だけです。
- **red-firstの受け入れテスト。** コントローラが受け入れコマンドを自分で実行します。開始時に手を付けていないツリーで失敗することを先に確かめ、最初から通ってしまう見せかけの関門を防ぎます。リファクタのように最初から通るのが正しい作業には**保存検証**（`verification:{kind:"preserve",protect:[...]}`）を使い、テストやフィクスチャが作業中に一度も変わっていないことをコントローラがスナップショットで証明します。
- **AC追跡表とPR下書き。** `acceptance_map`で受け入れ基準（AC1…）とそれを証明するコマンドを結びます。完了時にAC別の判定表とPR説明の下書き（`pr-draft.md`）を残します。変更一覧は最初のワーカー開始時（`base-1`）からの最終的な累積差分です。途中で戻した変更は除き、ワーカーラウンドに帰属しないファイルは`unattributed_changes`として別に表示します。`verification.json`と`report`にも同じ一覧を記録します。コミット・プッシュは引き続きユーザーが指示します。
- **レビュー委任。** ラウンドのレビューをSolなど別のモデルが読み取り専用で行い、判定を適用します。Opusがdiffを精読するトークンを節約できます。レビュアーにはdiff（最大100,000文字）とコントローラが自分で実行した受け入れテストの結果が渡され、シェルしかないCodexレビュアーも読み取り専用コマンドでファイルを開けます。実装したモデルは自分のレビューができません。→ [review](references/review-protocol.md)
- **相談。** ワーカー1人（advisor）が先にdiffを検査するか、2人（committee）が繰り返す失敗の原因を分析します。読み取り専用で、相談前後のスナップショットで保証します。→ [consult](references/consult.md)
- **ラウンド間の変更もレビュー。** 後続の`begin`は現在のツリーと直前の`post_digest`を比較します。スコープ内のファイルをBashで書いた場合も、不一致ならleaseや試行予算を消費する前に`RECOVERY_REQUIRED`で停止します。プリフライト中の変更も確認します。`recover`は確認済みのdigestを次の開始基準に更新し、累積レビューは復旧後に保持した変更も確認します。その変更をワーカーの実績としたり、自動承認したりはしません。最初の`begin`前にあったユーザー変更は保持します。→ [recovery](references/recovery-protocol.md)

**リードの負担を減らす**

- **短い出力と`next`。** コマンドラインの出力は既定でcompact表示です（全体は`--full`）。`next`は今の段階で打つコマンド1行と、tokenやdigestのようにコントローラが知っている値をあらかじめ埋めた入力の雛形を返します。
- **裁量権（オプトイン）。** リードがinitで作業単位に`delegation`を与えると、コントローラが条件をすべて確認できた場合にSTANDARDラウンドを承認し（`delegated-policy`として記録）、結果なしで一時障害により終わったワーカー実行を巻き戻して再試行し、終えられなかったレビュアーを別の会社のモデルに差し替えます。条件が一つでも足りなければリードゲートで止まります。裁量権のない作業はこれまで通り止まります。→ [universal-supervisor（韓国語）](references/universal-supervisor.md#위임-승인-재량권)
- **オートパイロット。** `autopilot`がラウンド実行と独立した委任レビューを自動で進めます（下の[インストールと使い方](#インストールと使い方)）。`report`の`lead_load`は、リードが自分で下した判定の数、コントローラが承認した数、リードが読む必要があったゲートの数、自動・手動の復旧の数を示します。
- **要約の後も続けられる。** リードガードのSessionStartフックが、会話が要約されたときや新しいセッションの開始時に、進行中の作業と次のコマンドを一度だけ知らせます。作業がなければ何も入れません。
- **作業状態の一行。** `fusion-state.mjs line`、UserPromptSubmitフック、プロンプト上のバンドモッド（`mods/hf-status`）が、同じ一行でフェーズ・ワーカーのラウンド・次の操作を表示します。リードに尋ねる必要はありません。[運用説明](references/operations.md#작업-상태-표시)
- **内蔵の記憶層。** 試行錯誤（エラー、手順、経験）を外部サーバーなしでローカルに蓄積し、次のセッションや他のワーカーに引き継ぎます。書き込みも読み取りもリードの承認を通り、秘密値は保存しません。→ [memory](references/memory.md)
- **通知。** `HF_NOTIFY_URL`（例：ntfy）で、ワーカーの完了やリードの判断が必要な時にスマホへプッシュ通知を受け取れます。本文は状態だけです。

**安全と監査**

- **単一writerと監査記録。** 同時に書くのは一人だけで、ラウンドごとにスナップショットと成果物が残ります。中断しても復旧手順で再開できます。自動のcommit・push・デプロイはありません。
- **リードガードフック。** leaseが掛かっている間やワーカーの予算が残っている間はリードのEdit/Writeをブロックし（PreToolUse）、リードの番の作業を残したままターンを終えようとすると一度止めます（Stop）。このフックはBashの書き込みを止めず、スナップショットとラウンド間のdrift検査が変更を確認します。→ [operations（韓国語）](references/operations.md#리드-가드-훅)
- **独立worktreeと作業上限。** 作業ごとに状態とwriter leaseを分離して並列実行し、報告された費用と経過時間に上限を設けます。結果は個別に検収してから統合します。→ [並列実行・上限（韓国語）](references/operations.md)
- **Linux・macOS・Windows対応。**

## v0.3: External-Firstと共通監視（オプトイン）

`hyperfusion.v03.config.example.json`を対象リポジトリの`hyperfusion.config.json`にコピーして明示的に有効化します。既存のclassic設定と実行中のタスクは自動変更されません。詳細は[universal-supervisor](references/universal-supervisor.md)（韓国語）を参照してください。

- **External-First配置。** 自動実装はGrok・Antigravity・Lunaが担当します。Sonnet（重要/再割り当てラウンド）とSol（APEXラウンド）はラウンドごとのgrantがある場合のみ実装し、自動フォールバックや新人優遇はこの2つを選びません。
- **作者別のレビュー。** 原則は一つ、実装したモデルは自分のラウンドをレビューしません。既定はGrok/AGYの通常作業→Sol、Luna→Sonnet、重要作業→Sol＋Sonnetの二重PASS。レビュアーが上限や障害で止まったらリードが理由を書いて別のモデルに差し替え、残るレビュアーがいなければリードが自分でdiffを読んで埋めます。差し戻しに納得できなければ、リードが理由を書いて別のモデルに再レビューを頼み、代わりのレビュアーがpassすれば自分で確認したうえで覆せます。結果は`LEAD_DECISION_REQUIRED`で止まり、`auto_apply`・`review {adopt}`・オートパイロットでもホストリードの最終判断ゲートは飛ばせません（リードがinitで裁量権を与えた作業だけが例外です）。
- **共通ローカル監視。** すべてのimplement/review/consult呼び出しを同じsupervisorが観測します（`status --monitor`、`monitor --once|--watch`）。無信号はQUIET警告にとどまり、進捗や成功を生成しません。監視でモデルは呼びません。
- **使用量の計測とクォータ。** 実装・レビュー・相談・失敗呼び出しとAPEX Solを含めて記録し、未計測は`null`のままにします。クォータは`scripts/quota-policy.mjs`で記録します。運用者が直接書き込む（`record`）か、Codexが自分のセッション記録に残した`rate_limits`を読んでopenaiの残量を記録します（`collect-codex`、ネットワークもモデルも使いません）。記録は出所と有効期限が過ぎると「不明」として扱います。
- **既定の推論強度。** Sonnet high、Haiku max、Antigravity high、Grok xhigh、Luna xhigh、Sol medium。設定`reasoning_effort`で上書きでき、`null`ならフラグを渡しません。
- ホストが本当にOpusかは認証できないため、`authority.model_verified:false`として記録します。

## セキュリティ

ワーカーがユーザーのファイルを勝手に触れないよう、何層かで防ぎます。ただしこれは**協調的な統制であり、OSのサンドボックスではありません。**

- 制御ファイル（状態、brief、スナップショット）は作業フォルダの外`~/.hyperfusion/state/`に置きます（`HF_STATE_DIR`で変更）。ワーカーが自分で範囲を広げることはできません。
- スナップショットは`.git`の設定・フック、リンクworktreeの専用`config.worktree`、`.env`、無視された`.gitignore`、`node_modules/.bin`まで見ます。コントローラのgitは呼び出し直前にinclude・条件付きinclude・worktreeを含む実際の適用設定を読み直し、実行可能なドライバーを無効化します。設定を読めなければ`GIT_CONFIG_UNREADABLE`で停止し、ドットを含むドライバー・条件付きinclude名も検査します。安全性のため設定照会プロセスは増えますが、HEADと両Gitフォルダは引き続き1回のrev-parseで取得します。
- ブリッジは実行直前にリクエストを再生成して照合します。ワーカーには必要な環境変数だけを渡します。
- Bashの許可ルールはテスト・lint・ビルドの形だけを受け付けます。サンドボックス解除などの緩和は、リポジトリ設定ではなくオペレーターの環境変数でのみ有効にします（[configuration](references/configuration.md#보안-관련-환경변수)）。
- 読み取り専用の相談・レビューは、ツールのサンドボックスではなく前後のスナップショット比較で保証します（破った回答は捨てます）。Antigravityの`--sandbox`はターミナルだけを制限し、ファイル書き込みツールは止められません。

シェルを使えるワーカーは作業フォルダ外のファイルに触れ得ますし、スナップショット比較はリポジトリの外への書き込みを捉えられません。既に無視されている通常の依存ファイル（例：`node_modules/dep/index.js`）の内容変更はスナップショットで監視しません。コントローラが受け入れテストを直接実行する際は、無視されたファイルのメタデータを比較し、変化があれば実行しません（[operations](references/operations.md#수용-테스트-자동-실행)）。旧方式で制御ファイルを作業フォルダ内に置いていた場合は`fusion-state.mjs migrate <リポジトリ>`で移行します。互換性のない保存スキーマには、文書のarchive手順を適用してください。詳細は[configuration](references/configuration.md)、[recovery](references/recovery-protocol.md)。

## インストールと使い方

必要なもの：Node.js 20+、`git config --show-scope --includes`をサポートするGit、**初期コミットのあるGitリポジトリ**（リモートなしのローカル専用でも可）、インストール・認証済みの`claude`、`grok`、`agy`、`codex`のうち1つ以上。表のモデルIDは設定の既定値です。実際のCLI・アカウントでの利用可否を確認してください。

```sh
# Linux / macOS
git clone https://github.com/prentice7725/hyperfusion.git ~/.claude/skills/hyperfusion
```

```powershell
# Windows (PowerShell)
git clone https://github.com/prentice7725/hyperfusion.git "$env:USERPROFILE\.claude\skills\hyperfusion"
```

Claude CodeでOpus 5.5を選び：

```text
/hyperfusion <作業内容>
/hyperfusion --executor sonnet <作業内容>
```

リードが[SKILL.md](SKILL.md)に従ってコントローラとブリッジを呼び出します。まず`node scripts/setup-doctor.mjs <リポジトリ>`でインストール状況を点検してください。設定は対象リポジトリの`hyperfusion.config.json`（例：`hyperfusion.config.example.json`）です。

**リードガードフックの導入（推奨）。** `npm run guard:settings`が、このPCの絶対パスで書かれたフック設定（PreToolUse、Stop、SessionStart、UserPromptSubmit、SessionEnd、StopFailure）を出力します。その`hooks`の項目を`~/.claude/settings.json`（または対象リポジトリの`.claude/settings.json`）にマージします。既存の導入でも各イベントの新しい使用量収集コマンドをマージしてください。他のフックを保持し、既存コマンドの重複を避けます。

**オートパイロット。** 初期化済みの作業は`node scripts/fusion-state.mjs autopilot <リポジトリ>`でラウンド実行と独立した委任レビューを自動進行できます。リードが承認した`acceptance_commands`が必要で、基準ツリーで失敗が確認された（red）コマンドでなければなりません（保存検証の作業は逆に、すでに通ることが確認されている必要があります）。classicのレビューでは`review.auto_apply:true`も必要です（`lead-gated-adaptive`はどのみちリードゲートで止まるため要求しません）。VERIFY・設計判断・BLOCKED・takeoverではリードに制御を返し、プロセス停止・スナップショット・予算・検証の確認に失敗した場合も停止します。リードが裁量権を与えた作業は、コントローラが承認したラウンドのverifyまで進みます（[運用説明（韓国語）](references/operations.md#오토파일럿)）。

受け入れテストでも子プロセスの停止を確認します。停止の証拠がなければRECOVERY_REQUIREDで止まり、リードの停止確認を待ちます。タスクの時間上限は受け入れテストと最終検証にも適用されます。

外部に送るbrief・diff・過去の結果には、メール・IP・キー・パスワードのパターンマスキングを標準適用します。認証に必要なベンダー環境変数は維持します。CLIが直接読み取って送るリポジトリの内容まで保護するDLPではないため、社内コードではファイルアクセスと外部送信の方針も別途管理してください（[送信範囲（韓国語）](references/operations.md#외부-전송-마스킹)）。

## ドキュメント

ドキュメントの本文は韓国語です。最初は[runtime](references/runtime.md)（コマンド）と[configuration](references/configuration.md)（設定）から読んでください。

| テーマ | ドキュメント |
|---|---|
| 状態とコマンド | [runtime](references/runtime.md) · [state-actions](references/state-actions.md)（自動生成） · [state-schema](references/state-schema.json) · [operations](references/operations.md)（運用・オートパイロット・フック・受け入れテスト） |
| 設定 | [configuration](references/configuration.md)（環境変数を含む） |
| ワーカー | [executor-runtime](references/executor-runtime.md)（Windows含む） · [routing](references/routing.md) |
| 契約 | [delegation-protocol](references/delegation-protocol.md)（brief） · [result-protocol](references/result-protocol.md) |
| 検収 | [review-protocol](references/review-protocol.md) · [consult](references/consult.md) · [universal-supervisor](references/universal-supervisor.md)（v0.3・裁量権） |
| 失敗と復旧 | [failure-protocol](references/failure-protocol.md) · [recovery-protocol](references/recovery-protocol.md) |
| プロジェクト・記憶・指標 | [project](references/project.md) · [memory](references/memory.md) · [metrics-policy](references/metrics-policy.md) |
| 設計メモと過去の記録 | [app-handoff-design](references/app-handoff-design.md)（後続設計） · [archive](references/archive/README.md)（時点ごとの検証・監査記録） |

## テストと制約

```sh
npm test
```

自動テストが、状態機械、ワーカーアダプタ、配置、レビュー委任、裁量権と自動復旧、記憶層、プロジェクトの流れ、セキュリティ、マスキングとオートパイロットを確認します。実際のCLIを使うスモーク1件は`HF_LIVE=1`の時だけ実行します。GitHub ActionsはUbuntu・Windows × Node 20・24で実行する構成です。Windowsではテストファイルを順次実行し（他のOSは並列度2）、実際に孤児プロセスを作る回帰テストは並列テストの後に別途実行して、プロセス一覧の干渉を避けます。Windowsではプロセスの生成回数がそのまま時間になるため、`npm run spawns`がテスト（または指定したコマンド）の作る子プロセスをコマンド別・呼び出し箇所別に数えて表示します。

**テストの`grok`/`agy`/`claude`/`codex`は代役のCLIです。** 実際のモデル呼び出し、認証、画像生成は、このリポジトリのテストでは検証されていません。インストール済みCLIに必要なフラグがない場合は、実行前に`ADAPTER_UNAVAILABLE`で拒否します。CLIフラグは[Grok Build](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)、[Antigravity CLI](https://antigravity.google/docs/cli/headless)、[Claude Code](https://code.claude.com/docs/en/headless)のドキュメントを基準にしています。裁量権の自動復旧が「やり直しても同じ失敗」を見分ける文言判定も代役CLIが基準なので、実際のCLIでは最初の数回、`recovery-*.json`の`reason`を確認することをおすすめします。

ライセンスは[MIT](LICENSE)。

## 参考にしたもの

- [Orca](https://github.com/stablyai/orca)、[Paseo](https://github.com/getpaseo/paseo)：advisor/committee、行単位のフィードバック、通知。worktree競争は単一作業ツリーの原則と合わないため取り入れていません。
- [AnchorMind](https://github.com/jinho-von-choi/memento-mcp)：記憶層の設計（重複統合、矛盾レビュー、減衰、出典表示）。接続はせず、設計だけを取り入れて自前で実装しました。
- [cli-dispatch](https://github.com/rbinar/cli-dispatch)：他社のCLIに仕事を任せる似たプラグイン。agyのモデル名検証、コンパクション後の状態注入、Codex残量の読み取りを参考にしました。worktreeのパッチ方式は単一writerの原則と合わないため取り入れていません。
