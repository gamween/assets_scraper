import { App } from "@/components/app/app";

/** Reads `?url=` on the server so a shared link renders the scanning layout at once, without a landing flash. */
export default async function Home({ searchParams }: PageProps<"/">) {
  const { url } = await searchParams;
  return <App initialUrl={typeof url === "string" ? url : null} />;
}
