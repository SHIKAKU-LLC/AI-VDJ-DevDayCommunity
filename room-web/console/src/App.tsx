import type { RoomView } from "./room-view";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  MusicNotesIcon,
  PlayIcon,
  StopIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
  CornersOutIcon,
  PaperPlaneTiltIcon,
  ImageIcon,
  UsersIcon,
  XIcon,
  WaveformIcon,
  SlidersHorizontalIcon,
  QueueIcon,
  CheckCircleIcon,
  ArrowRightIcon,
  BroadcastIcon,
} from "@phosphor-icons/react";
import { createRoomController } from "../../judge-controller.mjs";
import { REFERENCE_IMAGE_ACCEPT } from "../../judge-image.mjs";
import { Button } from "./components/ui/button";
import { CreditName } from "./components/credit-name";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "./components/ui/card";
import { Field, FieldLabel, FieldDescription } from "./components/ui/field";
import { Input } from "./components/ui/input";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputAttachments,
  PromptInputToolbar,
  PromptInputActions,
  PromptInputSubmit,
} from "./components/ui/prompt-input";
import {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentAction,
} from "./components/ui/attachment";
import {
  TrackList,
  TrackListItem,
  TrackListItemIndex,
  TrackListItemContent,
  TrackListItemTitle,
  TrackListItemDescription,
  TrackListItemDuration,
} from "./components/ui/track-list";
import { StatusDot } from "./components/ui/status-dot";
import { Progress } from "./components/ui/progress";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "./components/ui/empty";
import { Skeleton } from "./components/ui/skeleton";
import { Note, NoteContent } from "./components/ui/note";
import { ThemeSwitcher } from "./components/ui/theme-switcher";
import { Fader } from "./components/ui/fader";
import {
  LevelMeter,
  LevelMeterValue,
  LevelMeterChannels,
  LevelMeterChannel,
  LevelMeterTrack,
  LevelMeterBar,
  LevelMeterHold,
} from "./components/ui/level-meter";
import {
  LcdDisplay,
  LcdDisplayRow,
  LcdDisplayLabel,
  LcdDisplayValue,
} from "./components/ui/lcd-display";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
} from "./components/ui/sidebar";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "./components/ui/sheet";
import type { FrameSource, MeterFrame } from "./lib/signal/types";

const defaultController = createRoomController();
// The controller owns all audio, media, credentials and requests. Components
// subscribe to a presentation snapshot; no credential enters React props.
type Controller = typeof defaultController;
const time = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
const narrowQuery = () => window.matchMedia("(max-width:1279px)");
const watchLayout = (listener: () => void) => {
  const query = narrowQuery();
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
};
const readLayout = () => narrowQuery().matches;
const safeState = (state: string) =>
  state === "READY"
    ? "ready"
    : state === "FAILED" || state === "NEEDS_REVIEW"
      ? "error"
      : state === "QUEUED"
        ? "queued"
        : "building";
function Panel({
  title,
  description,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}
function Output({ controller, state }: { controller: Controller; state: any }) {
  const source = useMemo<FrameSource<MeterFrame>>(
    () => ({
      subscribe(listener) {
        const timer = setInterval(() => {
          if (!document.hidden) listener(controller.readOutput());
        }, 50);
        return () => clearInterval(timer);
      },
    }),
    [controller],
  );
  return (
    <div className="master-output">
      <div className="flex items-center justify-between gap-3">
        <span className="text-label-13 font-medium">出力音量</span>
        <span className="font-mono text-xs tabular-nums">
          {state.muted || state.gainDb <= -60
            ? "無音"
            : `${state.gainDb.toFixed(1)} dB`}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <Button
          id="mute"
          variant={state.muted ? "destructive" : "outline"}
          size="icon"
          aria-label={state.muted ? "ミュートを解除" : "ミュート"}
          aria-pressed={state.muted}
          onClick={() => controller.setOutput(state.gainDb, !state.muted)}
        >
          {state.muted ? <SpeakerSlashIcon /> : <SpeakerHighIcon />}
        </Button>
        <Fader
          min={-60}
          max={0}
          resetValue={0}
          silenceAtMin
          value={state.gainDb <= -60 ? -Infinity : state.gainDb}
          onValueChange={(value) => controller.setOutput(value)}
          variant="console"
          taper="audio"
          aria-label="出力音量"
        />
      </div>
      <LevelMeter
        source={source}
        channelCount={2}
        minDb={-60}
        maxDb={0}
        variant="segmented"
        aria-label="出力レベル 左右"
      >
        <LevelMeterChannels>
          {[0, 1].map((index) => (
            <LevelMeterChannel key={index} index={index}>
              <LevelMeterTrack>
                <LevelMeterBar />
                <LevelMeterHold />
              </LevelMeterTrack>
            </LevelMeterChannel>
          ))}
        </LevelMeterChannels>
        <LevelMeterValue />
      </LevelMeter>
    </div>
  );
}
function Composer({
  controller,
  state,
  primary,
}: {
  controller: Controller;
  state: RoomView;
  primary: boolean;
}) {
  const [prompt, setPrompt] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const busy = state.submitBusy || state.imageBusy;
  const full =
    state.submissions.length >= (state.maximumSets ?? 100) ||
    state.remainingSets === 0;
  return (
    <Panel
      title="ひとことで、次の熱狂を。"
      description="音楽も映像も、同じアイデアから。"
    >
      <Field>
        <FieldLabel htmlFor="prompt">音楽と映像のイメージ</FieldLabel>
        <PromptInput
          onSubmit={async (event) => {
            event.preventDefault();
            if (await controller.submit(prompt)) setPrompt("");
          }}
        >
          {state.image && (
            <PromptInputAttachments>
              <Attachment>
                <AttachmentMedia variant="image">
                  <img src={state.image.url} alt="添付した参考画像" />
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{state.image.name}</AttachmentTitle>
                </AttachmentContent>
                <AttachmentAction
                  aria-label="画像を外す"
                  disabled={busy}
                  onClick={() => {
                    controller.clearReference();
                    if (file.current) file.current.value = "";
                  }}
                >
                  <XIcon />
                </AttachmentAction>
              </Attachment>
            </PromptInputAttachments>
          )}
          <PromptInputTextarea
            id="prompt"
            placeholder="例：ネオンの猫、宇宙を走る低音"
            maxLength={2000}
            required
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={busy || full || !state.accepting}
            aria-describedby="prompt-help"
          />
          <PromptInputToolbar>
            <PromptInputActions>
              {state.imageEnabled && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy || full}
                  onClick={() => file.current?.click()}
                >
                  <ImageIcon />
                  画像を添付
                </Button>
              )}
            </PromptInputActions>
            <PromptInputSubmit
              size="sm"
              className="h-8 w-auto px-3"
              status={busy ? "submitted" : "idle"}
              variant={primary ? "default" : "secondary"}
              disabled={busy || !prompt.trim() || full || !state.accepting}
              aria-label={
                state.role === "owner"
                  ? "音楽・映像を生成する"
                  : "このアイデアを送る"
              }
            >
              <PaperPlaneTiltIcon />
              {busy ? "送信中" : state.role === "owner" ? "生成する" : "送る"}
            </PromptInputSubmit>
          </PromptInputToolbar>
        </PromptInput>
        <FieldDescription id="prompt-help">
          短い言葉だけで大丈夫。画像は任意です。演出の詳しい指示は自動で作ります。
        </FieldDescription>
      </Field>
      <input
        ref={file}
        className="sr-only"
        tabIndex={-1}
        type="file"
        accept={REFERENCE_IMAGE_ACCEPT}
        aria-label="参考画像（任意）"
        onChange={(event) => {
          const selected = event.target.files?.[0];
          void controller.attach(selected);
          event.target.value = "";
        }}
      />
      {full && (
        <Note variant="warning">
          <NoteContent>
            生成枠の上限に達しました。完成した投稿とプリセットを続けて楽しめます。
          </NoteContent>
        </Note>
      )}
      {!state.accepting && (
        <Note>
          <NoteContent>新しい投稿の受付はお休み中です。</NoteContent>
        </Note>
      )}
      {state.imageBusy && (
        <p role="status" className="text-copy-13 text-muted-foreground">
          画像を読み込んでいます…
        </p>
      )}
    </Panel>
  );
}
function Generation({
  controller,
  state,
}: {
  controller: Controller;
  state: RoomView;
}) {
  return (
    <Panel
      title="生成状況"
      description={state.budget ?? "届いたアイデアから演出を準備します。"}
    >
      {state.presetBatchId && (
        <Button
          variant="outline"
          onClick={() => void controller.startPresets()}
        >
          承認済みの待機音楽を準備
        </Button>
      )}
      {!state.submissions.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WaveformIcon />
            </EmptyMedia>
            <EmptyTitle>次のアイデアを待っています</EmptyTitle>
            <EmptyDescription>
              短い言葉を投稿すると、ここで進み具合を確認できます。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="space-y-4">
          {state.submissions.map((submission) => {
            const job = state.jobs.find(
              (j) => j.id === submission.submissionId,
            );
            const sceneCount = job?.sceneCount ?? 0;
            const ready = Object.entries(job?.progress ?? {}).filter(
              ([key, value]) => key.startsWith("video") && value === "READY",
            ).length;
            return (
              <li
                key={submission.submissionId}
                className="space-y-2 border-b border-border pb-4 last:border-0 last:pb-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-label-13 font-medium">
                    {submission.nickname}
                  </span>
                  <StatusDot
                    state={safeState(job?.state ?? "QUEUED")}
                    label={
                      job
                        ? (controller.labels[
                            job.state as keyof typeof controller.labels
                          ] ?? "準備中")
                        : "受付済み"
                    }
                  />
                </div>
                <p className="text-copy-14 break-words">{submission.prompt}</p>
                {job && (
                  <p className="text-copy-13 text-muted-foreground">
                    採用 {job.adopted ?? 0} 回
                  </p>
                )}
                {sceneCount > 1 && (
                  <>
                    <Progress
                      value={(100 * ready) / sceneCount}
                      aria-label="完成した映像の割合"
                    />
                    <p className="font-mono text-xs text-muted-foreground">
                      映像 {ready} / {sceneCount} 本
                    </p>
                  </>
                )}
                {job?.direction?.summary && (
                  <p className="text-copy-13 text-muted-foreground">
                    {job.direction.summary}
                  </p>
                )}
                {job &&
                  (job.state === "FAILED" ||
                    Object.values(job.progress ?? {}).includes("FAILED")) && (
                    <Button
                      variant="outline"
                      size="sm"
                      loading={state.retryBusy === job.id}
                      onClick={() => controller.retry(job.id)}
                    >
                      生成済み素材の確認を再試行
                    </Button>
                  )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
function Invitation({
  controller,
  state,
}: {
  controller: Controller;
  state: RoomView;
}) {
  const invitation = controller.getInvitation();
  return (
    <Panel
      title="会場のみんなを招待"
      description="QRコードを読み取るだけで参加できます。"
    >
      {invitation && (
        <>
          <div
            className="qr-panel"
            role="img"
            aria-label="参加用QRコード"
            dangerouslySetInnerHTML={{ __html: invitation.svg }}
          />
          <Field>
            <FieldLabel htmlFor="join-url">参加用URL</FieldLabel>
            <Input id="join-url" value={invitation.url} readOnly />
          </Field>
          <Button variant="outline" onClick={() => controller.copyInvitation()}>
            URLをコピー
          </Button>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => controller.toggleAcceptance()}>
          {state.accepting ? "受付を閉じる" : "受付を開く"}
        </Button>
      </div>
      <p className="text-copy-13 text-muted-foreground">
        生成費用は運営側が負担します。参加者への請求はありません。1投稿は音楽・映像それぞれ12秒。初採用・採用回数の少ない人を優先します。
      </p>
    </Panel>
  );
}
export function App({
  controller = defaultController,
}: {
  controller?: Controller;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  ) as unknown as RoomView;
  const stage = useRef<HTMLElement>(null),
    videos = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const narrow = useSyncExternalStore(watchLayout, readLayout, () => false);
  const [tab, setTab] = useState("video");
  const [nickname, setNickname] = useState("");
  const [detail, setDetail] = useState<string | null>(null);
  useLayoutEffect(() => {
    void controller.start({
      stage: stage.current,
      videos: videos.current,
      "vj-overlay": canvas.current,
    });
  }, [controller]);
  const owner = state.role === "owner",
    room = !!state.role;
  useEffect(() => {
    if (state.role === "participant") setTab("prompt");
  }, [state.role]);
  const primary = !(
    owner &&
    state.ready &&
    !state.running &&
    (!narrow || tab === "video")
  );
  return (
    <SidebarProvider defaultOpen>
      <a href="#main" className="skip-link">
        本文へ移動
      </a>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <div className="flex items-center gap-3 p-2">
            <div className="brand-symbol">
              <WaveformIcon weight="bold" />
            </div>
            <div className="group-data-[collapsible=icon]:hidden">
              <p className="text-heading-20">AI VDJ</p>
              <p className="text-label-12 text-muted-foreground">
                みんなでつくる音楽空間
              </p>
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>ルーム操作</SidebarGroupLabel>
            <SidebarMenu>
              {[
                {
                  key: "video",
                  label: owner ? "操作卓" : "はじめに",
                  icon: SlidersHorizontalIcon,
                },
                {
                  key: "prompt",
                  label: "アイデアを投稿",
                  icon: PaperPlaneTiltIcon,
                },
                { key: "progress", label: "生成状況", icon: QueueIcon },
              ].map(({ key, label, icon: Icon }) => (
                <SidebarMenuItem key={key}>
                  <SidebarMenuButton
                    isActive={tab === key}
                    tooltip={label}
                    disabled={!room || (!owner && key === "video")}
                    onClick={() => setTab(key)}
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <div className="space-y-3 p-2 group-data-[collapsible=icon]:hidden">
            <StatusDot
              state={
                state.loading
                  ? "building"
                  : state.generation
                    ? "ready"
                    : "queued"
              }
              label={
                state.loading
                  ? "接続確認中"
                  : state.generation
                    ? "ブラウザで利用できます"
                    : "準備中"
              }
            />
            <p className="text-copy-13 text-muted-foreground">
              言葉が音になる。
              <br />
              会場がひとつになる。
            </p>
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="console-header">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger aria-label="ナビゲーションを開閉" />
            <span className="text-label-14 font-medium">
              {owner ? "ライブ操作卓" : room ? "会場に参加" : "AI VDJ"}
            </span>
            <span className="role-label">
              {owner ? "オーナー" : room ? "参加者" : "音と映像のセッション"}
            </span>
          </div>
          <ThemeSwitcher size="sm" />
        </header>
        <main id="main" className="console-main">
          {!room && (
            <section className="welcome-layout">
              <div className="space-y-6">
                <p className="text-label-13 text-muted-foreground">
                  LIVE MUSIC × GENERATIVE VISUALS
                </p>
                <h1 className="text-heading-32 md:text-heading-48">
                  ひとことから始まる、
                  <br />
                  音と映像のセッション。
                </h1>
                <p className="text-copy-16 text-muted-foreground max-w-xl">
                  思いついた情景も、好きなキャラクターも。あなたと会場のみんなのアイデアから、音楽と映像が生まれます。
                </p>
                <div className="flex flex-wrap gap-2">
                  {["ブラウザだけで参加", "画像は任意", "途切れない演出"].map(
                    (label) => (
                      <span key={label} className="feature-tag">
                        <CheckCircleIcon />
                        {label}
                      </span>
                    ),
                  )}
                </div>
              </div>
              <Panel
                title={
                  state.joining ? "会場に参加する" : "あなたのルームを開こう"
                }
                description={
                  state.joining
                    ? "呼ばれたい名前を入力してください。"
                    : "インストールもAPIキーの入力もいりません。"
                }
              >
                {state.loading ? (
                  <>
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-4 w-3/4" />
                  </>
                ) : state.joining ? (
                  <form
                    className="space-y-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void controller.join(nickname);
                    }}
                  >
                    <Field>
                      <FieldLabel htmlFor="nickname">呼ばれたい名前</FieldLabel>
                      <Input
                        id="nickname"
                        required
                        maxLength={40}
                        autoComplete="nickname"
                        placeholder="例：ゆき"
                        value={nickname}
                        onChange={(event) => setNickname(event.target.value)}
                      />
                    </Field>
                    <Button
                      type="submit"
                      loading={state.joinBusy}
                      disabled={!nickname.trim()}
                      className="w-full"
                    >
                      参加する
                      <ArrowRightIcon />
                    </Button>
                  </form>
                ) : (
                  <>
                    <div className="welcome-steps">
                      <span>01</span>
                      <p>ルームを開いて、みんなを招待</p>
                      <span>02</span>
                      <p>ひとことや画像から、音と映像を生成</p>
                      <span>03</span>
                      <p>大画面で、会場と一緒に楽しむ</p>
                    </div>
                    <Button
                      id="create"
                      onClick={() => controller.create()}
                      disabled={!state.generation}
                      loading={state.createBusy}
                      className="w-full"
                    >
                      ルームを開く
                      <ArrowRightIcon />
                    </Button>
                    <p className="text-copy-13 text-muted-foreground">
                      {state.generation
                        ? "準備はできています。好きなイメージで始めましょう。"
                        : "生成サービスを準備しています。"}
                    </p>
                  </>
                )}
              </Panel>
            </section>
          )}
          {room && (
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-label-12 text-muted-foreground">
                  {owner ? "あなたのルーム" : "参加中のルーム"}
                </p>
                <h1 className="text-heading-24">
                  {owner
                    ? "会場の熱を、ここから。"
                    : "あなたのアイデアが、次の一曲に。"}
                </h1>
              </div>
              <StatusDot
                state={state.running ? "ready" : "queued"}
                label={state.running ? "再生中" : owner ? "待機中" : "参加中"}
              />
            </div>
          )}
          {room && (
            <nav className="mobile-tabs" aria-label="表示パネル">
              {[
                { key: "video", label: "映像", hide: !owner },
                { key: "prompt", label: "投稿" },
                { key: "progress", label: "生成状況" },
              ]
                .filter((i) => !i.hide)
                .map((i) => (
                  <Button
                    variant={tab === i.key ? "secondary" : "ghost"}
                    key={i.key}
                    aria-pressed={tab === i.key}
                    onClick={() => setTab(i.key)}
                  >
                    {i.label}
                  </Button>
                ))}
            </nav>
          )}
          <div
            className={room ? "room-layout" : "hidden"}
            data-panel={tab}
            data-owner={owner}
          >
            <div
              className="stage-column"
              hidden={!owner}
              inert={narrow && tab !== "video" ? true : undefined}
              aria-hidden={narrow && tab !== "video" ? true : undefined}
            >
              <section
                id="stage"
                ref={stage}
                className="stage surface-panel"
                aria-label="映像と再生操作"
              >
                <div className="video-viewport">
                  <div id="videos" ref={videos} className="videos" />
                  <canvas id="vj-overlay" ref={canvas} aria-hidden="true" />
                  {!state.hasVideo && (
                    <div className="stage-empty">
                      <WaveformIcon weight="thin" />
                      <p className="text-heading-20">
                        次の熱狂は、あなたの言葉から。
                      </p>
                      <p className="text-copy-13 text-muted-foreground">
                        音楽と映像が揃ったら、再生を始められます。
                      </p>
                    </div>
                  )}
                  {state.credit && (
                    <aside className="stage-credit" aria-label="この曲のアイデア投稿者">
                      <CreditName name={state.credit} />
                    </aside>
                  )}
                </div>
                <div className="transport-panel">
                  <div className="transport-main">
                    <div className="transport-buttons">
                      <Button
                        id="play"
                        aria-label="再生する"
                        variant={!primary ? "default" : "secondary"}
                        disabled={!state.ready || state.running}
                        onClick={() => controller.play()}
                      >
                        <PlayIcon weight="fill" />
                        再生する
                      </Button>
                      <Button
                        id="stop"
                        variant="outline"
                        disabled={!state.running}
                        onClick={() => controller.stop()}
                      >
                        <StopIcon weight="fill" />
                        停止
                      </Button>
                      <Button
                        id="fullscreen"
                        variant="outline"
                        size="icon"
                        aria-label="全画面を切り替える"
                        title="全画面（F）"
                        onClick={() => controller.fullscreen()}
                      >
                        <CornersOutIcon />
                      </Button>
                    </div>
                    <LcdDisplay
                      matrix={false}
                      size="sm"
                      variant="green"
                      className="time-display"
                    >
                      <LcdDisplayRow>
                        <LcdDisplayLabel>経過</LcdDisplayLabel>
                        <LcdDisplayValue>{time(state.elapsed)}</LcdDisplayValue>
                      </LcdDisplayRow>
                    </LcdDisplay>
                    <p className="play-status" role="status">
                      {state.playStatus}
                    </p>
                  </div>
                  <Output controller={controller} state={state} />
                </div>
              </section>
              <Panel
                title="このルームの曲"
                description="音楽と映像を12秒ずつ。みんなの投稿を公平に、途切れずにつなぎます。"
                className="mt-4"
              >
                {!state.tracks?.length ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <MusicNotesIcon />
                      </EmptyMedia>
                      <EmptyTitle>まだ曲がありません</EmptyTitle>
                      <EmptyDescription>
                        最初のアイデアを投稿して、会場の音をつくりましょう。
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <TrackList aria-label="完成した曲">
                    {state.tracks.map((track, index) => (
                      <TrackListItem
                        key={track.id}
                        active={state.currentId === track.id}
                        playing={state.running && state.currentId === track.id}
                        onSelect={() =>
                          setDetail(detail === track.id ? null : track.id)
                        }
                        aria-label={`${index + 1}曲目の詳細 ${track.prompt}`}
                      >
                        <TrackListItemIndex>{index + 1}</TrackListItemIndex>
                        <TrackListItemContent>
                          <TrackListItemTitle>
                            {track.prompt}
                          </TrackListItemTitle>
                          <TrackListItemDescription>
                            {track.nickname}
                            {detail === track.id
                              ? " · 再生順は投稿順です。曲の切り替えは自動です。"
                              : ""}
                          </TrackListItemDescription>
                        </TrackListItemContent>
                        <TrackListItemDuration>
                          {time(track.duration)}
                        </TrackListItemDuration>
                      </TrackListItem>
                    ))}
                  </TrackList>
                )}
              </Panel>
            </div>
            <aside className="side-panels">
              <div className="composer-panel">
                <Composer
                  controller={controller}
                  state={state}
                  primary={primary}
                />
              </div>
              <div className="generation-panel">
                <Generation controller={controller} state={state} />
              </div>
              {owner && (
                <Sheet>
                  <SheetTrigger
                    render={<Button variant="outline" className="w-full" />}
                  >
                    <UsersIcon />
                    みんなを招待・受付設定
                  </SheetTrigger>
                  <SheetContent>
                    <SheetHeader>
                      <SheetTitle>ルームの招待と設定</SheetTitle>
                      <SheetDescription>
                        招待した人は自分のブラウザから参加できます。
                      </SheetDescription>
                    </SheetHeader>
                    <div className="p-4 overflow-y-auto">
                      <Invitation controller={controller} state={state} />
                    </div>
                  </SheetContent>
                </Sheet>
              )}
            </aside>
          </div>
          <div className="feedback">
            <div role="status" aria-live="polite">
              {state.status && (
                <Note variant="success">
                  <NoteContent>{state.status}</NoteContent>
                </Note>
              )}
            </div>
            <div role="alert">
              {state.error && (
                <Note variant="error">
                  <NoteContent>
                    <p>{state.error}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() => controller.recheck()}
                    >
                      状態を再確認
                    </Button>
                  </NoteContent>
                </Note>
              )}
            </div>
          </div>
          <footer className="console-footer">
            <span>AI VDJ</span>
            <span>音楽と映像はAIで生成されます。</span>
          </footer>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
