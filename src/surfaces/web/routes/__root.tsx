import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import styleUrl from "../renderer/styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Agent Workflow Runtime | History" }
    ],
    links: [{ rel: "stylesheet", href: styleUrl }]
  }),
  component: () => <Outlet />,
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
});
