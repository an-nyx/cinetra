import { ShowRepository } from "../model/show.repository";
import { Show, CreateShowDto, UpdateShowDto } from "../model/show.entity";
import { prisma } from '../../../database/prisma';

export class ShowPrismaRepository implements ShowRepository {
  private prisma = prisma;

  async findById(showId: string, userId: string): Promise<Show | null> {
    const show = await this.prisma.show.findUnique({
      where: { id: showId, userId: userId }
    });
    return show;
  }

  async findAll(userId: string): Promise<Show[]> {
    const shows = await this.prisma.show.findMany({
      where: { userId: userId }
    });
    return shows;
  }

  async create(showData: CreateShowDto, userId: string): Promise<Show> {
    const existing = await this.prisma.show.findFirst({ where: {
      userId,
      OR: [
        ...(showData.tmdbId ? [{ tmdbId: showData.tmdbId }] : []),
        ...(showData.tvmazeId ? [{ tvmazeId: showData.tvmazeId }] : []),
        { name: { equals: showData.name, mode: 'insensitive' } },
      ],
    } });
    if (existing) throw new Error('Show already exists');
    const newShow = await this.prisma.show.create({
      data: {...showData, userId: userId}
    });
    return newShow;
  }

  async update(showId: string, showData: UpdateShowDto, userId: string): Promise<Show | null> {
    // First check if the show exists and belongs to the user
    const existingShow = await this.prisma.show.findFirst({
      where: { id: showId, userId: userId }
    });

    if (!existingShow) {
      return null;
    }

    const updatedShow = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Show" WHERE id = ${showId} AND "userId" = ${userId} FOR UPDATE`;
      const current = await tx.show.findFirst({ where: { id: showId, userId } });
      if (!current) return null;
      const wasCompleted = current.status === 'completed' || (!current.status && current.completed);
      const nextStatus = showData.status !== undefined ? showData.status : current.status;
      const nextCompletedFlag = showData.completed !== undefined ? showData.completed : current.completed;
      const isCompleted = nextStatus === 'completed' || (!nextStatus && nextCompletedFlag);
      const boundary = isCompleted && !wasCompleted ? new Date() : !isCompleted && wasCompleted ? null : undefined;
      const result = await tx.show.update({ where: { id: showId }, data: { ...showData, ...(boundary !== undefined ? { completedMonitorFrom: boundary } : {}) } });
      if (showData.seasonsWatched !== undefined || showData.episodesWatched !== undefined) {
        await tx.episodeWatch.updateMany({ where: { showId }, data: { checkpointBeforeSeason: null, checkpointBeforeEpisode: null, checkpointAfterSeason: null, checkpointAfterEpisode: null } });
      }
      return result;
    });

    return updatedShow;
  }

  async delete(showId: string, userId: string): Promise<{ count: number }> {
    const show = await this.prisma.show.deleteMany({
      where: { id: showId, userId: userId }
    });
    return show;
  }
}
