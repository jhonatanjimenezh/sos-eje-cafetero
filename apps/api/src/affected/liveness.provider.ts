export type TemporaryAwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
};

export type CreateLivenessSessionInput = {
  profileId: string;
  requestToken: string;
};

export type CreateLivenessSessionResult = {
  provider: string;
  sessionId: string;
  region: string;
  expiresAt: Date;
  credentials: TemporaryAwsCredentials;
};

export type LivenessSessionResult = {
  provider: string;
  sessionId: string;
  status: string;
  confidence: number | null;
  referenceImage?: { bucket?: string; key?: string };
  auditImages?: Array<{ bucket?: string; key?: string }>;
};

export interface LivenessProvider {
  readonly name: string;
  createSession(input: CreateLivenessSessionInput): Promise<CreateLivenessSessionResult>;
  getResults(sessionId: string): Promise<LivenessSessionResult>;
}
