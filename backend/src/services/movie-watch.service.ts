import { prisma } from '../database/prisma';


export async function getMovieWatches(movieId: string, userId: string) {
  const movie = await prisma.movie.findFirst({ where: { id: movieId, userId }, select: { id: true } });
  if (!movie) return null;
  return prisma.movieWatch.findMany({ where: { movieId }, orderBy: { watchedAt: 'desc' } });
}

export async function addMovieWatch(movieId: string, userId: string, watchedAt: Date) {
  return prisma.$transaction(async tx => {
    const movie = await tx.movie.findFirst({ where: { id: movieId, userId }, select: { id: true } });
    if (!movie) return null;
    const watch = await tx.movieWatch.create({ data: { movieId, watchedAt } });
    await tx.movie.update({ where: { id: movieId }, data: { status: 'watched' } });
    return watch;
  });
}
