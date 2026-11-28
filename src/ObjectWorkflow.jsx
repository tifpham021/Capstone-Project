import EnrollObject from './EnrollObject.jsx'
import './ObjectPages.css'

export default function ObjectWorkflow({ onInspectProduct }) {
  return (
    <main id="main" className="obj-page obj-workflow-page">
      <header className="obj-heading obj-workflow-heading">
        <div>
          <h1>Product catalog</h1>
          <p>Enroll a genuine product and save reusable reference images and weight data.</p>
        </div>
      </header>
      <EnrollObject embedded onScanObject={onInspectProduct} />
    </main>
  )
}
