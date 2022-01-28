import {
  User,
  Channel,
  IngestChannel,
  Stats,
  Video,
  VideoEvent,
  ChannelSpotted,
} from './domain';
import {
  channelRepository,
  statsRepository,
  videoRepository,
} from './database';
import {
  IUploadService,
  mapTo,
  MessageBus,
  userRepository,
  IYoutubeClient,
} from '..';
import { S3UploadService } from './uploadService';
import { getMatchingFrequencies, Frequency } from './frequency';

export class SyncService {
  private _uploader: IUploadService;
  constructor(private youtube: IYoutubeClient, private bus: MessageBus) {
    this._uploader = new S3UploadService(youtube);
  }
  async startIngestionFor(frequencies: Frequency[]): Promise<Channel[]> {
    const rawChannels = await channelRepository()
      .scan('frequency')
      .in(frequencies)
      .exec();
    const channels = rawChannels.map((ch) => mapTo<Channel>(ch));
    console.log('Found channels', channels);
    await new MessageBus('eu-west-1').publishAll(
      channels.map((ch) => new IngestChannel(ch, Date.now())),
      'channelEvents'
    );
    return channels;
  }
  async ingestChannels(user: User): Promise<ChannelSpotted[]> {
    if (!(await this.canCallYoutube())) return [];

    return this.youtube
      .getChannels(user)
      .then((channels) => {
        channelRepository().batchPut(channels);
        userRepository().update({ ...user, channelsCount: channels.length });
        return channels;
      })
      .then((channels) =>
        channels.map((ch) => new ChannelSpotted(ch, Date.now()))
      )
      .then((events) => this.bus.publishAll(events, 'channelEvents'));
  }
  async ingestAllVideos(channel: Channel, top: number) {
    if (!(await this.canCallYoutube())) return [];
    return await this.youtube
      .getAllVideos(channel, top)
      .then((videos) => this.onlyNewVideos(channel, videos))
      .then((videos) =>
        videos.map((v) => new VideoEvent('new', v.id, v.channelId, Date.now()))
      )
      .then((events) => this.bus.publishAll(events, 'videoEvents'));
  }

  async uploadVideo(channelId: string, videoId: string) {
    return this._uploader.uploadVideo(channelId, videoId);
  }

  private async onlyNewVideos(
    channel: Channel,
    videos: Video[]
  ): Promise<Video[]> {
    const existingVideos = await videoRepository()
      .query({ channelId: channel.id })
      .filter('id')
      .in(videos.map((v) => v.id))
      .exec();
    return videos.filter((v) => !existingVideos.find((e) => e.id == v.id));
  }
  private async canCallYoutube(): Promise<boolean> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const statsDoc = await statsRepository().get({
      partition: 'stats',
      date: today.setUTCHours(0, 0, 0, 0),
    });
    const stats = mapTo<Stats>(statsDoc);
    return stats.quotaUsed < 10000;
  }
}