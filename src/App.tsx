import { useEffect, useState } from "react";
import {
  detectCli,
  listRoles,
  pipelineDefsList,
  type CliDetectResult,
  type RoleSummary,
} from "./bridge";
import { setPipelineDefs } from "./pipeline/defs";
import { StartupForm } from "./StartupForm";
import { ConfirmHost } from "./components/confirm";
import "./App.css";

const showDevTools =
  import.meta.env.DEV ||
  import.meta.env.VITE_SHOW_DEVTOOLS === "true";

function App() {
  const [cli, setCli] = useState<CliDetectResult | null>(null);
  const [cliError, setCliError] = useState<string | null>(null);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [rolesError, setRolesError] = useState<string | null>(null);
  // Bumped when your own pipelines load, so chain labels re-render.
  const [, setPipelinesLoaded] = useState(0);

  useEffect(() => {
    detectCli()
      .then(setCli)
      .catch((err: unknown) => {
        setCliError(err instanceof Error ? err.message : String(err));
      });
    listRoles()
      .then(setRoles)
      .catch((err: unknown) => {
        setRoles([]);
        setRolesError(err instanceof Error ? err.message : String(err));
      });
    pipelineDefsList()
      .then((defs) => {
        setPipelineDefs(defs ?? []);
        setPipelinesLoaded((n) => n + 1);
      })
      // intentionally silent: the built-in pipelines are bundled and still work.
      .catch(() => {});
  }, []);

  const redetectCli = async () => {
    const result = await detectCli();
    setCli(result);
    setCliError(null);
    return result;
  };

  return (
    <main className="workspace">
      <StartupForm
        roles={roles}
        cli={cli}
        cliError={cliError}
        rolesError={rolesError}
        cliFound={!!cli?.found}
        showDevTools={showDevTools}
        onRedetectCli={redetectCli}
        onPipelinesChanged={() => setPipelinesLoaded((n) => n + 1)}
        onRefreshRoles={() =>
          listRoles().then((next) => {
            setRoles(next);
            setRolesError(null);
          })
        }
      />
      <ConfirmHost />
    </main>
  );
}

export default App;
