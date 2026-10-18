/** Presentation-only data. Credentials, signed URLs and media bytes stay in the controller. */
export interface SubmissionView {
  submissionId: string;
  nickname: string;
  prompt: string;
}
export interface JobView {
  id: string;
  state: string;
  sceneCount?: number;
  adopted?: number;
  progress?: Record<string, string>;
  direction?: { summary?: string };
  reason?: string;
}
export interface RoomView {
  loading: boolean;
  role: "owner" | "participant" | null;
  joining: boolean;
  status: string;
  error: string;
  submissions: SubmissionView[];
  jobs: JobView[];
  tracks?: { id: string; nickname: string; prompt: string; duration: number }[];
  accepting: boolean;
  autoGenerate: boolean;
  generation: boolean;
  imageEnabled: boolean;
  image: { url: string; name: string } | null;
  createBusy: boolean;
  joinBusy: boolean;
  submitBusy: boolean;
  imageBusy: boolean;
  imageError?: boolean;
  retryBusy?: string | null;
  ready: boolean;
  playBusy?: boolean;
  running: boolean;
  credit: string;
  currentId?: string;
  playStatus: string;
  gainDb: number;
  muted: boolean;
  elapsed: number;
  budget?: string;
  presetBatchId?: string;
  maximumSets?: number;
  remainingSets?: number | null;
  hasVideo?: boolean;
  displayConnected?: boolean;
}
