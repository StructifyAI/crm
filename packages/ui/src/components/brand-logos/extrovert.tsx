import type * as React from "react";

const ExtrovertLogo = (props: React.SVGProps<SVGSVGElement>) => (
	<svg
		viewBox="0 0 24 24"
		xmlns="http://www.w3.org/2000/svg"
		aria-hidden="true"
		{...props}
	>
		<rect width="24" height="24" rx="6" fill="currentColor" />
		<path d="M13.7 3.8 6.5 13h4.7l-.9 7.2 7.2-9.3h-4.7l.9-7.1Z" fill="white" />
	</svg>
);

export default ExtrovertLogo;
