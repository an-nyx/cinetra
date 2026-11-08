import { MovieRepository } from "../model/movie.repository";
import { Movie, CreateMovieDto, UpdateMovieDto } from "../model/movie.entity";
import { prisma } from '../../../database/prisma';

export class MoviePrismaRepository implements MovieRepository {
  private prisma = prisma;

  async findById(movieId: string, userId: string): Promise<Movie | null> {
    const movie = await this.prisma.movie.findUnique({
      where: { id: movieId, userId: userId }
    });
    return movie;
  }

  async findAll(userId: string): Promise<Movie[]> {
    const movies = await this.prisma.movie.findMany({
      where: { userId: userId },
      orderBy: { updatedAt: 'desc' }
    });
    return movies;
  }

  async create(movieData: CreateMovieDto, userId: string): Promise<Movie> {
    const existing = await this.prisma.movie.findFirst({ where: {
      userId,
      OR: [
        ...(movieData.tmdbId ? [{ tmdbId: movieData.tmdbId }] : []),
        { name: { equals: movieData.name, mode: 'insensitive' } },
      ],
    } });
    if (existing) throw new Error('Movie already exists');
    const newMovie = await this.prisma.movie.create({
      data: {...movieData, userId: userId}
    });
    return newMovie;
  }

  async update(movieId: string, movieData: UpdateMovieDto, userId: string): Promise<Movie | null> {
    // First check if the movie exists and belongs to the user
    const existingMovie = await this.prisma.movie.findFirst({
      where: { id: movieId, userId: userId }
    });

    if (!existingMovie) {
      return null;
    }

    const updatedMovie = await this.prisma.movie.update({
      where: { id: movieId },
      data: movieData
    });
    return updatedMovie;
  }

  async delete(movieId: string, userId: string): Promise<{ count: number }> {
    const movie = await this.prisma.movie.deleteMany({
      where: { id: movieId, userId: userId }
    });
    return movie;
  }
}
