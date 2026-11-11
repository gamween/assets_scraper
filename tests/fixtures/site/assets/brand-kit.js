// The kit button of monad.xyz/brand-and-media-kit, in the shape its bundle has: the download starts from code, so no
// link on the page carries the URL. The social icon is the rest of the site's bundle, which is not part of the kit.
const KIT = "/brand-page-assets/Fixture Brand and Media Kit.zip";
const LOGOS = ["/brand-page-assets/Logomark.svg", "/socials/discord.svg"];
document.getElementById("kit")?.addEventListener("click", () => {
  const link = document.createElement("a");
  link.href = KIT;
  link.download = "Fixture Brand and Media Kit.zip";
  link.click();
});
window.fixtureLogos = LOGOS;
