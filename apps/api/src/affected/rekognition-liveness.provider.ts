import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  CreateFaceLivenessSessionCommand,
  GetFaceLivenessSessionResultsCommand,
  RekognitionClient,
} from '@aws-sdk/client-rekognition';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import {
  CreateLivenessSessionInput,
  CreateLivenessSessionResult,
  LivenessProvider,
  LivenessSessionResult,
} from './liveness.provider';

@Injectable()
export class RekognitionLivenessProvider implements LivenessProvider {
  readonly name = 'REKOGNITION';
  private readonly region = process.env.AWS_REGION ?? 'us-east-1';
  private readonly rekognition = new RekognitionClient({ region: this.region });
  private readonly sts = new STSClient({ region: this.region });

  async createSession(input: CreateLivenessSessionInput): Promise<CreateLivenessSessionResult> {
    const roleArn = process.env.LIVENESS_CLIENT_ROLE_ARN;
    if (!roleArn) throw new ServiceUnavailableException('LIVENESS_CLIENT_ROLE_ARN no configurado');

    const bucket = process.env.PRIVATE_EVIDENCE_BUCKET;
    const kmsKeyId = process.env.EVIDENCE_KMS_KEY_ID || undefined;
    const prefix = `private/liveness/${input.profileId}/${input.requestToken}`;

    const created = await this.rekognition.send(new CreateFaceLivenessSessionCommand({
      ClientRequestToken: input.requestToken,
      KmsKeyId: kmsKeyId,
      Settings: {
        AuditImagesLimit: 1,
        ...(bucket ? { OutputConfig: { S3Bucket: bucket, S3KeyPrefix: prefix } } : {}),
      },
    }));
    if (!created.SessionId) throw new ServiceUnavailableException('Rekognition no creó la sesión de liveness');

    const assumed = await this.sts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `sos-liveness-${input.profileId.slice(0, 8)}`,
      DurationSeconds: 900,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: ['rekognition:StartFaceLivenessSession'], Resource: '*' }],
      }),
    }));
    const credentials = assumed.Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken || !credentials.Expiration) {
      throw new ServiceUnavailableException('No fue posible obtener credenciales temporales para liveness');
    }

    return {
      provider: this.name,
      sessionId: created.SessionId,
      region: this.region,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      credentials: {
        accessKeyId: credentials.AccessKeyId,
        secretAccessKey: credentials.SecretAccessKey,
        sessionToken: credentials.SessionToken,
        expiration: credentials.Expiration.toISOString(),
      },
    };
  }

  async getResults(sessionId: string): Promise<LivenessSessionResult> {
    const result = await this.rekognition.send(new GetFaceLivenessSessionResultsCommand({ SessionId: sessionId }));
    return {
      provider: this.name,
      sessionId,
      status: result.Status ?? 'UNKNOWN',
      confidence: typeof result.Confidence === 'number' ? result.Confidence : null,
      referenceImage: result.ReferenceImage?.S3Object ? {
        bucket: result.ReferenceImage.S3Object.Bucket,
        key: result.ReferenceImage.S3Object.Name,
      } : undefined,
      auditImages: result.AuditImages?.map(image => ({
        bucket: image.S3Object?.Bucket,
        key: image.S3Object?.Name,
      })),
    };
  }
}
