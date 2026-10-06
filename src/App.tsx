import { useEffect, useState } from "react";
import { detectCli, listRoles, type CliDetectResult, type RoleSummary } from "./bridge";
import { StartupForm } from "./StartupForm";
import "./App.css";

const showDevTools =
  import.meta.env.DEV ||
  import.meta.env.VITE_SHOW_DEVTOOLS === "true";

function App() {
  const [cli, setCli] = useState<CliDetectResult | null>(null);
  const [cliError, setCliError] = useState<string | null>(null);
  const [roles, setRoles] = useState<RoleSummary[]>([]);

  useEffect(() => {
    detectCli()
      .then(setCli)
      .catch((err: unknown) => {
        setCliError(err instanceof Error ? err.message : String(err));
      });
    listRoles()
      .then(setRoles)
      .catch(() => setRoles([]));
  }, []);

  return (
    <main className="workspace">
      <StartupForm
        roles={roles}
        cli={cli}
        cliError={cliError}
        cliFound={!!cli?.found}
        showDevTools={showDevTools}
      />
    </main>
  );
}

export default App;
