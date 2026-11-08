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

    const updatedShow = await this.prisma.show.update({
      where: { id: showId },
      data: showData
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
